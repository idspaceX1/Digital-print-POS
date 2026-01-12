const EventEmitter = require('events');
const os = require('os');

class InventoryModule extends EventEmitter {
    constructor(database) {
        super();
        this.db = database;
        this.lowStockThreshold = 10;
        this.reorderPoint = 20;
        this.inventoryCache = new Map();
        this.cacheTTL = 300000; // 5 minutes
        this.lastInventoryCheck = Date.now();
        
        // x86 specific optimizations
        this.useSSE = os.arch() === 'x64' && this.checkSSESupport();
        this.bufferSize = 1024 * 1024; // 1MB buffer for batch operations
        
        this.setupEventHandlers();
        this.startPeriodicTasks();
    }

    checkSSESupport() {
        // Check for SSE support (x86 feature)
        try {
            const cpuid = require('child_process').spawnSync('grep', ['-o', '-P', '(?<=flags\\t:).*', '/proc/cpuinfo']);
            if (cpuid.stdout) {
                const flags = cpuid.stdout.toString().toLowerCase();
                return flags.includes('sse') || flags.includes('sse2') || flags.includes('sse3');
            }
        } catch (e) {
            console.log('SSE detection failed, assuming no SSE support');
        }
        return false;
    }

    setupEventHandlers() {
        this.on('low_stock', (product) => {
            console.log(`LOW STOCK ALERT: ${product.name} (${product.sku}) - ${product.quantity} units remaining`);
            this.triggerReorder(product);
        });

        this.on('stock_adjusted', (details) => {
            this.logInventoryEvent('STOCK_ADJUSTMENT', details);
        });

        this.on('product_added', (product) => {
            this.logInventoryEvent('PRODUCT_ADDED', product);
        });
    }

    startPeriodicTasks() {
        // Check low stock every 5 minutes
        setInterval(() => {
            this.checkLowStock();
        }, 300000);

        // Clean cache every 10 minutes
        setInterval(() => {
            this.cleanCache();
        }, 600000);
    }

    async addProduct(productData) {
        const requiredFields = ['sku', 'name', 'unit_price', 'cost_price', 'quantity'];
        
        for (const field of requiredFields) {
            if (!productData[field]) {
                throw new Error(`Missing required field: ${field}`);
            }
        }

        try {
            const result = await this.db.run(
                `INSERT INTO products (
                    sku, name, description, category, unit_price, cost_price, 
                    quantity, min_stock_level, max_stock_level, supplier_id, 
                    barcode, weight, dimensions, tax_rate, location
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    productData.sku,
                    productData.name,
                    productData.description || '',
                    productData.category || 'Uncategorized',
                    productData.unit_price,
                    productData.cost_price,
                    productData.quantity,
                    productData.min_stock_level || 10,
                    productData.max_stock_level || 100,
                    productData.supplier_id || null,
                    productData.barcode || '',
                    productData.weight || 0,
                    productData.dimensions || '',
                    productData.tax_rate || 0.0,
                    productData.location || 'A-01'
                ]
            );

            // Log inventory transaction
            await this.logInventoryTransaction({
                product_id: result.lastID,
                transaction_type: 'PURCHASE',
                quantity_change: productData.quantity,
                previous_quantity: 0,
                new_quantity: productData.quantity,
                unit_cost: productData.cost_price,
                total_cost: productData.cost_price * productData.quantity,
                reference_id: `INIT_${Date.now()}`,
                notes: 'Initial stock addition'
            });

            this.invalidateCache();
            this.emit('product_added', { ...productData, product_id: result.lastID });

            return result.lastID;
        } catch (error) {
            throw new Error(`Failed to add product: ${error.message}`);
        }
    }

    async updateStock(productId, quantityChange, reason = 'SALE', referenceId = null, notes = '') {
        await this.db.beginTransaction();

        try {
            // Get current stock
            const product = await this.db.query(
                'SELECT quantity, cost_price FROM products WHERE product_id = ?',
                [productId]
            );

            if (!product || product.length === 0) {
                throw new Error('Product not found');
            }

            const currentQty = product[0].quantity;
            const newQty = currentQty + quantityChange;

            if (newQty < 0) {
                throw new Error('Insufficient stock');
            }

            // Update product quantity
            await this.db.run(
                'UPDATE products SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ?',
                [newQty, productId]
            );

            // Log transaction
            await this.logInventoryTransaction({
                product_id: productId,
                transaction_type: reason.toUpperCase(),
                quantity_change: quantityChange,
                previous_quantity: currentQty,
                new_quantity: newQty,
                unit_cost: product[0].cost_price,
                total_cost: Math.abs(quantityChange) * product[0].cost_price,
                reference_id: referenceId,
                notes: notes
            });

            await this.db.commit();

            // Update cache
            this.inventoryCache.set(productId, {
                ...product[0],
                quantity: newQty,
                lastUpdated: Date.now()
            });

            // Check stock levels
            if (newQty <= this.lowStockThreshold) {
                this.emit('low_stock', {
                    product_id: productId,
                    sku: product[0].sku,
                    name: product[0].name,
                    quantity: newQty,
                    threshold: this.lowStockThreshold
                });
            }

            this.emit('stock_adjusted', {
                product_id: productId,
                quantity_change: quantityChange,
                new_quantity: newQty,
                reason: reason
            });

            return { success: true, new_quantity: newQty };
        } catch (error) {
            await this.db.rollback();
            throw error;
        }
    }

    async getProductBySKU(sku) {
        const cacheKey = `sku:${sku}`;
        
        if (this.inventoryCache.has(cacheKey)) {
            const cached = this.inventoryCache.get(cacheKey);
            if (Date.now() - cached.lastUpdated < this.cacheTTL) {
                return cached.data;
            }
        }

        const products = await this.db.query(
            `SELECT p.*, 
             (SELECT transaction_type FROM inventory_transactions 
              WHERE product_id = p.product_id 
              ORDER BY transaction_date DESC LIMIT 1) as last_transaction,
             (SELECT SUM(quantity_change) FROM inventory_transactions 
              WHERE product_id = p.product_id 
              AND transaction_date >= date('now', '-30 day')) as monthly_movement
             FROM products p WHERE sku = ?`,
            [sku]
        );

        if (products.length > 0) {
            this.inventoryCache.set(cacheKey, {
                data: products[0],
                lastUpdated: Date.now()
            });
            return products[0];
        }

        return null;
    }

    async getProductByBarcode(barcode) {
        // Optimized barcode search with direct index access
        const products = await this.db.query(
            'SELECT * FROM products WHERE barcode = ? AND is_active = 1',
            [barcode]
        );

        return products.length > 0 ? products[0] : null;
    }

    async batchUpdateStock(updates) {
        // Process batch updates efficiently
        await this.db.beginTransaction();

        try {
            const results = [];
            
            for (const update of updates) {
                try {
                    const result = await this.updateStock(
                        update.product_id,
                        update.quantity_change,
                        update.reason || 'ADJUSTMENT',
                        update.reference_id,
                        update.notes
                    );
                    results.push({ ...update, success: true, result });
                } catch (error) {
                    results.push({ ...update, success: false, error: error.message });
                }
            }

            await this.db.commit();
            return results;
        } catch (error) {
            await this.db.rollback();
            throw error;
        }
    }

    async checkLowStock() {
        const lowStockProducts = await this.db.query(
            `SELECT p.product_id, p.sku, p.name, p.quantity, p.min_stock_level, 
             p.supplier_id, p.location
             FROM products p 
             WHERE p.quantity <= p.min_stock_level 
             AND p.is_active = 1
             ORDER BY p.quantity ASC`
        );

        lowStockProducts.forEach(product => {
            this.emit('low_stock', product);
        });

        return lowStockProducts;
    }

    async getInventoryReport(startDate, endDate) {
        // Generate detailed inventory report
        const report = await this.db.query(
            `SELECT 
                p.product_id,
                p.sku,
                p.name,
                p.category,
                p.quantity as current_stock,
                p.min_stock_level,
                p.max_stock_level,
                p.unit_price,
                p.cost_price,
                p.location,
                COALESCE(SUM(CASE WHEN it.transaction_type = 'PURCHASE' THEN it.quantity_change ELSE 0 END), 0) as total_purchased,
                COALESCE(SUM(CASE WHEN it.transaction_type = 'SALE' THEN ABS(it.quantity_change) ELSE 0 END), 0) as total_sold,
                COALESCE(SUM(CASE WHEN it.transaction_type = 'RETURN' THEN it.quantity_change ELSE 0 END), 0) as total_returned,
                COALESCE(SUM(CASE WHEN it.transaction_type = 'WASTE' THEN ABS(it.quantity_change) ELSE 0 END), 0) as total_waste,
                COUNT(DISTINCT it.transaction_id) as transaction_count
             FROM products p
             LEFT JOIN inventory_transactions it ON p.product_id = it.product_id
                AND it.transaction_date BETWEEN ? AND ?
             WHERE p.is_active = 1
             GROUP BY p.product_id, p.sku, p.name, p.category, p.quantity, 
                      p.min_stock_level, p.max_stock_level, p.unit_price, 
                      p.cost_price, p.location
             ORDER BY p.category, p.sku`,
            [startDate, endDate]
        );

        // Calculate metrics
        const totalValue = report.reduce((sum, item) => {
            return sum + (item.current_stock * item.cost_price);
        }, 0);

        const totalPotential = report.reduce((sum, item) => {
            return sum + (item.current_stock * item.unit_price);
        }, 0);

        return {
            report_date: new Date().toISOString(),
            period: { start: startDate, end: endDate },
            summary: {
                total_products: report.length,
                total_value: totalValue,
                total_potential: totalPotential,
                avg_turnover: report.reduce((sum, item) => sum + item.total_sold, 0) / report.length
            },
            products: report
        };
    }

    async triggerReorder(product) {
        // Implement reorder logic
        const reorderQty = product.max_stock_level - product.quantity;
        
        if (reorderQty > 0) {
            console.log(`REORDER: Product ${product.sku} needs ${reorderQty} units`);
            
            // Here you would typically:
            // 1. Send email to supplier
            // 2. Create purchase order
            // 3. Update system records
        }
    }

    logInventoryEvent(eventType, details) {
        this.db.run(
            `INSERT INTO system_metrics (metric_name, metric_value, metric_type, unit, tags)
             VALUES (?, ?, ?, ?, ?)`,
            [
                'inventory_event',
                1,
                'COUNTER',
                'event',
                JSON.stringify({
                    event_type: eventType,
                    timestamp: new Date().toISOString(),
                    details: details
                })
            ]
        );
    }

    async logInventoryTransaction(transaction) {
        await this.db.run(
            `INSERT INTO inventory_transactions (
                product_id, transaction_type, quantity_change, previous_quantity,
                new_quantity, unit_cost, total_cost, reference_id, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                transaction.product_id,
                transaction.transaction_type,
                transaction.quantity_change,
                transaction.previous_quantity,
                transaction.new_quantity,
                transaction.unit_cost,
                transaction.total_cost,
                transaction.reference_id,
                transaction.notes
            ]
        );
    }

    cleanCache() {
        const now = Date.now();
        for (const [key, value] of this.inventoryCache.entries()) {
            if (now - value.lastUpdated > this.cacheTTL) {
                this.inventoryCache.delete(key);
            }
        }
    }

    invalidateCache() {
        this.inventoryCache.clear();
    }

    getCacheStats() {
        return {
            size: this.inventoryCache.size,
            hitRatio: this.calculateHitRatio(),
            memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024
        };
    }

    calculateHitRatio() {
        // Simplified hit ratio calculation
        return 0.85; // Would be calculated from actual stats
    }

    async searchProducts(query, filters = {}) {
        let sql = `SELECT * FROM products WHERE is_active = 1`;
        const params = [];
        
        if (query) {
            sql += ` AND (sku LIKE ? OR name LIKE ? OR barcode LIKE ? OR category LIKE ?)`;
            const searchTerm = `%${query}%`;
            params.push(searchTerm, searchTerm, searchTerm, searchTerm);
        }
        
        if (filters.category) {
            sql += ` AND category = ?`;
            params.push(filters.category);
        }
        
        if (filters.minPrice !== undefined) {
            sql += ` AND unit_price >= ?`;
            params.push(filters.minPrice);
        }
        
        if (filters.maxPrice !== undefined) {
            sql += ` AND unit_price <= ?`;
            params.push(filters.maxPrice);
        }
        
        if (filters.inStockOnly) {
            sql += ` AND quantity > 0`;
        }
        
        sql += ` ORDER BY name LIMIT 100`;
        
        return await this.db.query(sql, params);
    }
}

module.exports = InventoryModule;
