const crypto = require('crypto');
const EventEmitter = require('events');

class CashierModule extends EventEmitter {
    constructor(database, inventory) {
        super();
        this.db = database;
        this.inventory = inventory;
        this.currentSession = null;
        this.activeTransactions = new Map();
        this.cashDrawer = {
            total: 0,
            expected: 0,
            denominations: {
                '100': 0, '50': 0, '20': 0, '10': 0,
                '5': 0, '1': 0, '0.25': 0, '0.10': 0, '0.05': 0, '0.01': 0
            }
        };
        this.receiptCounter = 1;
        this.sessionStartTime = null;
        
        this.setupReceiptPrinting();
    }

    setupReceiptPrinting() {
        // ESC/POS command constants
        this.ESC = '\x1B';
        this.GS = '\x1D';
        this.LF = '\x0A';
        
        this.receiptConfig = {
            printerName: 'POSPrinter',
            paperWidth: 48,
            companyName: 'RETAIL STORE',
            address: '123 Main St, City',
            phone: '(555) 123-4567',
            taxId: 'TAX-123456789'
        };
    }

    async startSession(employeeId, registerId) {
        const employee = await this.db.query(
            'SELECT * FROM employees WHERE employee_id = ? AND is_active = 1',
            [employeeId]
        );

        if (!employee || employee.length === 0) {
            throw new Error('Invalid employee or not active');
        }

        // Generate session ID
        const sessionId = crypto.randomBytes(16).toString('hex');
        
        this.currentSession = {
            sessionId: sessionId,
            employeeId: employeeId,
            registerId: registerId,
            startTime: new Date().toISOString(),
            startCash: 100, // Starting cash float
            transactions: [],
            status: 'ACTIVE'
        };

        this.sessionStartTime = Date.now();
        this.cashDrawer.total = this.currentSession.startCash;
        this.cashDrawer.expected = this.currentSession.startCash;

        this.logSystemEvent('SESSION_START', {
            sessionId: sessionId,
            employeeId: employeeId,
            registerId: registerId
        });

        return this.currentSession;
    }

    async endSession() {
        if (!this.currentSession) {
            throw new Error('No active session');
        }

        const sessionEndTime = new Date().toISOString();
        
        // Calculate session totals
        const sessionReport = await this.generateSessionReport();
        
        this.currentSession.endTime = sessionEndTime;
        this.currentSession.endCash = this.cashDrawer.total;
        this.currentSession.status = 'ENDED';
        this.currentSession.report = sessionReport;

        // Log session end
        await this.logSystemEvent('SESSION_END', {
            sessionId: this.currentSession.sessionId,
            duration: Date.now() - this.sessionStartTime,
            ...sessionReport.summary
        });

        const endedSession = { ...this.currentSession };
        this.currentSession = null;
        this.sessionStartTime = null;
        this.activeTransactions.clear();

        return endedSession;
    }

    async createTransaction(employeeId, customerId = null) {
        if (!this.currentSession) {
            throw new Error('No active session');
        }

        const transactionId = `TXN${Date.now()}${Math.floor(Math.random() * 1000)}`;
        
        const transaction = {
            transactionId: transactionId,
            employeeId: employeeId,
            customerId: customerId,
            items: [],
            subtotal: 0,
            tax: 0,
            discount: 0,
            total: 0,
            status: 'OPEN',
            createdAt: new Date().toISOString(),
            payment: null
        };

        this.activeTransactions.set(transactionId, transaction);

        this.logSystemEvent('TRANSACTION_CREATED', {
            transactionId: transactionId,
            employeeId: employeeId
        });

        return transactionId;
    }

    async addItemToTransaction(transactionId, productSku, quantity) {
        const transaction = this.activeTransactions.get(transactionId);
        
        if (!transaction) {
            throw new Error('Transaction not found');
        }

        if (transaction.status !== 'OPEN') {
            throw new Error('Transaction is not open');
        }

        // Get product details
        const product = await this.inventory.getProductBySKU(productSku);
        
        if (!product) {
            throw new Error('Product not found');
        }

        if (product.quantity < quantity) {
            throw new Error(`Insufficient stock. Available: ${product.quantity}`);
        }

        // Calculate item total
        const itemPrice = product.unit_price;
        const itemTax = (itemPrice * quantity * (product.tax_rate / 100));
        const itemTotal = (itemPrice * quantity) + itemTax;

        const item = {
            product_id: product.product_id,
            sku: product.sku,
            name: product.name,
            quantity: quantity,
            unit_price: itemPrice,
            tax_rate: product.tax_rate,
            tax_amount: itemTax,
            total_price: itemTotal,
            cost_price: product.cost_price
        };

        transaction.items.push(item);
        
        // Recalculate totals
        this.recalculateTransactionTotals(transaction);

        this.logSystemEvent('ITEM_ADDED', {
            transactionId: transactionId,
            productSku: productSku,
            quantity: quantity,
            itemTotal: itemTotal
        });

        return item;
    }

    recalculateTransactionTotals(transaction) {
        transaction.subtotal = transaction.items.reduce((sum, item) => 
            sum + (item.unit_price * item.quantity), 0);
        
        transaction.tax = transaction.items.reduce((sum, item) => 
            sum + item.tax_amount, 0);
        
        transaction.total = transaction.subtotal + transaction.tax - transaction.discount;
    }

    async applyDiscount(transactionId, discountType, discountValue) {
        const transaction = this.activeTransactions.get(transactionId);
        
        if (!transaction) {
            throw new Error('Transaction not found');
        }

        let discountAmount = 0;
        
        switch (discountType) {
            case 'PERCENTAGE':
                discountAmount = (transaction.subtotal * discountValue) / 100;
                break;
            case 'AMOUNT':
                discountAmount = Math.min(discountValue, transaction.subtotal);
                break;
            case 'ITEM':
                // Apply discount to specific item
                break;
            default:
                throw new Error('Invalid discount type');
        }

        transaction.discount = discountAmount;
        this.recalculateTransactionTotals(transaction);

        return discountAmount;
    }

    async processPayment(transactionId, paymentMethod, amountTendered, cardDetails = null) {
        const transaction = this.activeTransactions.get(transactionId);
        
        if (!transaction) {
            throw new Error('Transaction not found');
        }

        if (transaction.status !== 'OPEN') {
            throw new Error('Transaction is not open for payment');
        }

        if (amountTendered < transaction.total) {
            throw new Error('Insufficient payment');
        }

        const change = amountTendered - transaction.total;

        transaction.payment = {
            method: paymentMethod,
            amount_tendered: amountTendered,
            change_given: change,
            card_details: cardDetails,
            processed_at: new Date().toISOString()
        };

        transaction.status = 'PAID';

        // Update cash drawer
        if (paymentMethod === 'CASH') {
            this.cashDrawer.total += transaction.total;
            this.cashDrawer.expected += transaction.total;
            
            // Track denominations (simplified)
            this.countCashDenominations(amountTendered, change);
        }

        // Save transaction to database
        await this.saveTransaction(transaction);

        // Update inventory
        for (const item of transaction.items) {
            await this.inventory.updateStock(
                item.product_id,
                -item.quantity,
                'SALE',
                transaction.transactionId,
                `Sale transaction: ${transaction.transactionId}`
            );
        }

        this.activeTransactions.delete(transactionId);

        this.logSystemEvent('PAYMENT_PROCESSED', {
            transactionId: transactionId,
            amount: transaction.total,
            paymentMethod: paymentMethod,
            change: change
        });

        // Generate receipt
        const receipt = this.generateReceipt(transaction);

        this.emit('payment_completed', {
            transaction: transaction,
            receipt: receipt
        });

        return {
            success: true,
            transaction: transaction,
            receipt: receipt,
            change: change
        };
    }

    countCashDenominations(amountTendered, change) {
        // Simplified cash denomination counting
        const denominations = [100, 50, 20, 10, 5, 1, 0.25, 0.10, 0.05, 0.01];
        
        let remaining = amountTendered;
        
        for (const denom of denominations) {
            if (remaining >= denom) {
                const count = Math.floor(remaining / denom);
                this.cashDrawer.denominations[denom.toString()] += count;
                remaining -= count * denom;
            }
        }
    }

    async saveTransaction(transaction) {
        await this.db.beginTransaction();

        try {
            // Save main transaction
            const saleResult = await this.db.run(
                `INSERT INTO sales_transactions (
                    transaction_id, cashier_id, total_amount, tax_amount, 
                    discount_amount, payment_method, cash_tendered, change_given,
                    customer_id, sale_status, register_id, receipt_number
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    transaction.transactionId,
                    transaction.employeeId,
                    transaction.total,
                    transaction.tax,
                    transaction.discount,
                    transaction.payment.method,
                    transaction.payment.amount_tendered,
                    transaction.payment.change_given,
                    transaction.customerId,
                    'COMPLETED',
                    this.currentSession.registerId,
                    `RCPT${this.receiptCounter.toString().padStart(8, '0')}`
                ]
            );

            // Save individual items
            for (const item of transaction.items) {
                const profit = (item.unit_price - item.cost_price) * item.quantity;
                
                await this.db.run(
                    `INSERT INTO sale_items (
                        sale_id, product_id, quantity, unit_price, 
                        discount_percentage, tax_amount, total_price, 
                        cost_price, profit
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        saleResult.lastID,
                        item.product_id,
                        item.quantity,
                        item.unit_price,
                        0, // discount percentage
                        item.tax_amount,
                        item.total_price,
                        item.cost_price,
                        profit
                    ]
                );
            }

            await this.db.commit();
            this.receiptCounter++;
            
        } catch (error) {
            await this.db.rollback();
            throw error;
        }
    }

    generateReceipt(transaction) {
        const receiptNumber = `RCPT${this.receiptCounter.toString().padStart(8, '0')}`;
        const dateTime = new Date().toLocaleString();
        
        // ESC/POS formatted receipt
        let receipt = '';
        
        // Company header
        receipt += this.centerText(this.receiptConfig.companyName) + this.LF;
        receipt += this.centerText(this.receiptConfig.address) + this.LF;
        receipt += this.centerText(this.receiptConfig.phone) + this.LF;
        receipt += this.centerText(`Tax ID: ${this.receiptConfig.taxId}`) + this.LF;
        receipt += '='.repeat(this.receiptConfig.paperWidth) + this.LF;
        
        // Transaction details
        receipt += `Receipt: ${receiptNumber}` + this.LF;
        receipt += `Date: ${dateTime}` + this.LF;
        receipt += `Cashier: ${transaction.employeeId}` + this.LF;
        receipt += '-'.repeat(this.receiptConfig.paperWidth) + this.LF;
        
        // Items
        receipt += this.formatLine('Item', 'Qty', 'Price', 'Total');
        receipt += '-'.repeat(this.receiptConfig.paperWidth) + this.LF;
        
        transaction.items.forEach(item => {
            const name = item.name.length > 20 ? item.name.substring(0, 17) + '...' : item.name;
            receipt += name + this.LF;
            receipt += this.formatLine('', item.quantity.toString(), 
                `$${item.unit_price.toFixed(2)}`, 
                `$${item.total_price.toFixed(2)}`);
        });
        
        receipt += '='.repeat(this.receiptConfig.paperWidth) + this.LF;
        
        // Totals
        receipt += this.formatLine('Subtotal:', '', '', `$${transaction.subtotal.toFixed(2)}`);
        receipt += this.formatLine('Tax:', '', '', `$${transaction.tax.toFixed(2)}`);
        
        if (transaction.discount > 0) {
            receipt += this.formatLine('Discount:', '', '', `-$${transaction.discount.toFixed(2)}`);
        }
        
        receipt += this.formatLine('TOTAL:', '', '', `$${transaction.total.toFixed(2)}`);
        receipt += '='.repeat(this.receiptConfig.paperWidth) + this.LF;
        
        // Payment
        receipt += `Payment: ${transaction.payment.method}` + this.LF;
        receipt += `Tendered: $${transaction.payment.amount_tendered.toFixed(2)}` + this.LF;
        receipt += `Change: $${transaction.payment.change_given.toFixed(2)}` + this.LF;
        receipt += '='.repeat(this.receiptConfig.paperWidth) + this.LF;
        
        // Footer
        receipt += this.centerText('Thank you for your business!') + this.LF;
        receipt += this.centerText('Returns within 30 days with receipt') + this.LF;
        
        // Add ESC/POS commands
        const escposReceipt = 
            this.ESC + '@' + // Initialize printer
            this.ESC + '!' + '\x00' + // Default font
            receipt +
            this.GS + 'V' + '\x41' + '\x00' + // Cut paper
            this.LF.repeat(5); // Feed paper
        
        return {
            plain_text: receipt,
            esc_pos: escposReceipt,
            receipt_number: receiptNumber,
            transaction_id: transaction.transactionId
        };
    }

    centerText(text) {
        const spaces = Math.max(0, Math.floor((this.receiptConfig.paperWidth - text.length) / 2));
        return ' '.repeat(spaces) + text;
    }

    formatLine(item, qty, price, total) {
        const itemWidth = 20;
        const qtyWidth = 5;
        const priceWidth = 10;
        const totalWidth = 13;
        
        const itemPart = item.padEnd(itemWidth);
        const qtyPart = qty.padStart(qtyWidth);
        const pricePart = price.padStart(priceWidth);
        const totalPart = total.padStart(totalWidth);
        
        return itemPart + qtyPart + pricePart + totalPart + this.LF;
    }

    async generateSessionReport() {
        if (!this.currentSession) {
            throw new Error('No active session');
        }

        const transactions = await this.db.query(
            `SELECT 
                COUNT(*) as total_transactions,
                SUM(total_amount) as total_sales,
                SUM(tax_amount) as total_tax,
                SUM(discount_amount) as total_discount,
                SUM(profit) as total_profit
             FROM sales_transactions st
             LEFT JOIN (
                 SELECT sale_id, SUM(profit) as profit 
                 FROM sale_items 
                 GROUP BY sale_id
             ) si ON st.sale_id = si.sale_id
             WHERE st.cashier_id = ?
             AND st.created_at >= ?`,
            [this.currentSession.employeeId, this.currentSession.startTime]
        );

        const paymentMethods = await this.db.query(
            `SELECT payment_method, COUNT(*) as count, SUM(total_amount) as total
             FROM sales_transactions
             WHERE cashier_id = ? AND created_at >= ?
             GROUP BY payment_method`,
            [this.currentSession.employeeId, this.currentSession.startTime]
        );

        return {
            summary: {
                start_time: this.currentSession.startTime,
                end_time: new Date().toISOString(),
                duration: Date.now() - this.sessionStartTime,
                ...transactions[0]
            },
            cash_drawer: {
                starting_cash: this.currentSession.startCash,
                expected_cash: this.cashDrawer.expected,
                actual_cash: this.cashDrawer.total,
                difference: this.cashDrawer.total - this.cashDrawer.expected,
                denominations: this.cashDrawer.denominations
            },
            payments: paymentMethods,
            session_id: this.currentSession.sessionId
        };
    }

    async voidTransaction(transactionId, reason) {
        const transaction = await this.db.query(
            'SELECT * FROM sales_transactions WHERE transaction_id = ?',
            [transactionId]
        );

        if (!transaction || transaction.length === 0) {
            throw new Error('Transaction not found');
        }

        if (transaction[0].sale_status !== 'COMPLETED') {
            throw new Error('Transaction cannot be voided');
        }

        await this.db.beginTransaction();

        try {
            // Update transaction status
            await this.db.run(
                'UPDATE sales_transactions SET sale_status = ? WHERE transaction_id = ?',
                ['VOID', transactionId]
            );

            // Get sale items to restock
            const saleItems = await this.db.query(
                'SELECT * FROM sale_items WHERE sale_id = ?',
                [transaction[0].sale_id]
            );

            // Restock items
            for (const item of saleItems) {
                await this.inventory.updateStock(
                    item.product_id,
                    item.quantity,
                    'RETURN',
                    transactionId,
                    `Void transaction: ${reason}`
                );
            }

            // Adjust cash drawer if cash transaction
            if (transaction[0].payment_method === 'CASH') {
                this.cashDrawer.total -= transaction[0].total_amount;
                this.cashDrawer.expected -= transaction[0].total_amount;
            }

            await this.db.commit();

            this.logSystemEvent('TRANSACTION_VOIDED', {
                transactionId: transactionId,
                reason: reason,
                amount: transaction[0].total_amount
            });

            return { success: true, transactionId: transactionId };
        } catch (error) {
            await this.db.rollback();
            throw error;
        }
    }

    logSystemEvent(eventType, details) {
        this.db.run(
            `INSERT INTO system_metrics (metric_name, metric_value, metric_type, unit, tags)
             VALUES (?, ?, ?, ?, ?)`,
            [
                'cashier_event',
                1,
                'COUNTER',
                'event',
                JSON.stringify({
                    event_type: eventType,
                    timestamp: new Date().toISOString(),
                    session_id: this.currentSession?.sessionId,
                    details: details
                })
            ]
        );
    }

    getActiveTransaction(transactionId) {
        return this.activeTransactions.get(transactionId);
    }

    getActiveTransactions() {
        return Array.from(this.activeTransactions.values());
    }

    getCashDrawerStatus() {
        return {
            ...this.cashDrawer,
            session: this.currentSession ? {
                sessionId: this.currentSession.sessionId,
                startTime: this.currentSession.startTime,
                employeeId: this.currentSession.employeeId
            } : null
        };
    }
}

module.exports = CashierModule;
