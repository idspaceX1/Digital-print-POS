const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');
const EventEmitter = require('events');

class DesignPrintModule extends EventEmitter {
    constructor(database) {
        super();
        this.db = database;
        this.printQueue = [];
        this.isPrinting = false;
        this.printerStatus = {};
        this.templateCache = new Map();
        
        // x86 specific printer optimizations
        this.useParallelPort = this.detectParallelPort();
        this.printerBuffer = Buffer.alloc(4096); // 4KB buffer
        this.bufferPosition = 0;
        
        this.loadPrinterConfig();
        this.startPrintQueueProcessor();
    }

    detectParallelPort() {
        if (os.platform() === 'win32') {
            // Check for LPT ports on Windows x86
            return fs.existsSync('LPT1') || fs.existsSync('LPT2');
        } else {
            // Check for parallel ports on Linux x86
            return fs.existsSync('/dev/lp0') || fs.existsSync('/dev/parport0');
        }
    }

    loadPrinterConfig() {
        const configPath = path.join(process.cwd(), 'printer-config.json');
        
        if (fs.existsSync(configPath)) {
            this.printerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } else {
            // Default configuration for x86 thermal printer
            this.printerConfig = {
                defaultPrinter: 'THERMAL_RECEIPT',
                printers: {
                    'THERMAL_RECEIPT': {
                        type: 'ESC/POS',
                        port: this.useParallelPort ? 'LPT1' : 'USB',
                        baudRate: 19200,
                        paperWidth: 48,
                        characterSet: 'PC437',
                        autoCut: true,
                        drawerKick: true
                    },
                    'REPORT_PRINTER': {
                        type: 'LASER',
                        port: 'NETWORK',
                        paperSize: 'A4',
                        duplex: true,
                        resolution: 600
                    },
                    'LABEL_PRINTER': {
                        type: 'THERMAL_LABEL',
                        port: 'USB',
                        width: 62,
                        height: 29,
                        dpi: 203
                    }
                },
                templates: {
                    'RECEIPT': 'receipt-template.html',
                    'INVOICE': 'invoice-template.html',
                    'PRICE_LABEL': 'label-template.html',
                    'SHIPPING_LABEL': 'shipping-template.html'
                }
            };
            
            // Save default config
            fs.writeFileSync(configPath, JSON.stringify(this.printerConfig, null, 2));
        }
    }

    startPrintQueueProcessor() {
        setInterval(() => {
            this.processPrintQueue();
        }, 1000); // Process queue every second
    }

    async addToPrintQueue(printJob) {
        const jobId = `JOB${Date.now()}${Math.floor(Math.random() * 1000)}`;
        
        const job = {
            jobId: jobId,
            documentType: printJob.documentType,
            contentType: printJob.contentType,
            content: printJob.content,
            printerName: printJob.printerName || this.printerConfig.defaultPrinter,
            copies: printJob.copies || 1,
            priority: printJob.priority || 1,
            status: 'PENDING',
            createdAt: new Date().toISOString(),
            createdBy: printJob.createdBy,
            referenceId: printJob.referenceId
        };
        
        // Save to database
        await this.db.run(
            `INSERT INTO print_jobs (
                document_type, content_type, content, printer_name,
                copies, priority, status, created_by, reference_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                job.documentType,
                job.contentType,
                job.content,
                job.printerName,
                job.copies,
                job.priority,
                job.status,
                job.createdBy,
                job.referenceId
            ]
        );
        
        // Add to memory queue
        this.printQueue.push(job);
        
        // Sort by priority
        this.printQueue.sort((a, b) => b.priority - a.priority);
        
        this.logPrintEvent('JOB_QUEUED', {
            jobId: jobId,
            documentType: job.documentType,
            printer: job.printerName
        });
        
        return jobId;
    }

    async processPrintQueue() {
        if (this.isPrinting || this.printQueue.length === 0) {
            return;
        }
        
        this.isPrinting = true;
        
        while (this.printQueue.length > 0) {
            const job = this.printQueue.shift();
            
            try {
                // Update job status
                await this.db.run(
                    'UPDATE print_jobs SET status = ?, started_at = CURRENT_TIMESTAMP WHERE job_id = ?',
                    ['PRINTING', job.jobId]
                );
                
                // Process based on document type
                let printData;
                
                switch (job.documentType) {
                    case 'RECEIPT':
                        printData = await this.processReceipt(job);
                        break;
                    case 'REPORT':
                        printData = await this.processReport(job);
                        break;
                    case 'LABEL':
                        printData = await this.processLabel(job);
                        break;
                    default:
                        printData = job.content;
                }
                
                // Send to printer
                await this.sendToPrinter(job.printerName, printData, job.copies);
                
                // Update job status
                await this.db.run(
                    'UPDATE print_jobs SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE job_id = ?',
                    ['COMPLETED', job.jobId]
                );
                
                this.logPrintEvent('JOB_COMPLETED', {
                    jobId: job.jobId,
                    printer: job.printerName,
                    copies: job.copies
                });
                
                this.emit('print_completed', {
                    jobId: job.jobId,
                    referenceId: job.referenceId
                });
                
            } catch (error) {
                console.error('Print job failed:', error);
                
                // Update job status
                await this.db.run(
                    'UPDATE print_jobs SET status = ?, error_message = ? WHERE job_id = ?',
                    ['FAILED', error.message, job.jobId]
                );
                
                this.logPrintEvent('JOB_FAILED', {
                    jobId: job.jobId,
                    error: error.message,
                    printer: job.printerName
                });
                
                this.emit('print_failed', {
                    jobId: job.jobId,
                    error: error.message
                });
            }
        }
        
        this.isPrinting = false;
    }

    async processReceipt(job) {
        const receiptData = typeof job.content === 'string' ? 
            JSON.parse(job.content) : job.content;
        
        // Load template
        const template = await this.loadTemplate('RECEIPT');
        
        // Generate ESC/POS commands
        let escpos = '';
        
        // Initialize printer
        escpos += '\x1B\x40'; // ESC @ - Initialize
        
        // Set character code table
        escpos += '\x1B\x74\x00'; // ESC t 0 - Code page 437
        
        // Company header
        escpos += this.centerText(this.printerConfig.companyName || 'RETAIL STORE') + '\n';
        escpos += this.centerText(this.printerConfig.address || '123 Main St') + '\n';
        escpos += this.centerText(this.printerConfig.phone || '(555) 123-4567') + '\n';
        escpos += '================================\n';
        
        // Receipt header
        escpos += `Receipt: ${receiptData.receipt_number}\n`;
        escpos += `Date: ${new Date(receiptData.date).toLocaleString()}\n`;
        escpos += `Cashier: ${receiptData.cashier}\n`;
        escpos += '--------------------------------\n';
        
        // Items
        escpos += this.formatLine('Item', 'Qty', 'Price', 'Total');
        escpos += '--------------------------------\n';
        
        receiptData.items.forEach(item => {
            const name = item.name.length > 16 ? item.name.substring(0, 13) + '...' : item.name;
            escpos += name + '\n';
            escpos += this.formatLine('', item.quantity, 
                `$${item.unit_price.toFixed(2)}`, 
                `$${item.total_price.toFixed(2)}`);
        });
        
        // Totals
        escpos += '================================\n';
        escpos += this.formatLine('Subtotal:', '', '', `$${receiptData.subtotal.toFixed(2)}`);
        escpos += this.formatLine('Tax:', '', '', `$${receiptData.tax.toFixed(2)}`);
        
        if (receiptData.discount > 0) {
            escpos += this.formatLine('Discount:', '', '', `-$${receiptData.discount.toFixed(2)}`);
        }
        
        escpos += this.formatLine('TOTAL:', '', '', `$${receiptData.total.toFixed(2)}`);
        escpos += '================================\n';
        
        // Payment
        escpos += `Payment: ${receiptData.payment_method}\n`;
        escpos += `Tendered: $${receiptData.amount_tendered.toFixed(2)}\n`;
        escpos += `Change: $${receiptData.change_given.toFixed(2)}\n`;
        escpos += '================================\n';
        
        // Footer
        escpos += this.centerText('Thank you for your business!') + '\n';
        escpos += this.centerText('Returns within 30 days with receipt') + '\n';
        
        // Add barcode if present
        if (receiptData.barcode) {
            escpos += '\n';
            escpos += this.generateBarcode(receiptData.barcode);
        }
        
        // Paper cut and feed
        escpos += '\n\n\n\n\n'; // Feed 5 lines
        escpos += '\x1D\x56\x41\x00'; // GS V 65 0 - Cut paper
        
        // Open cash drawer
        if (this.printerConfig.printers[job.printerName]?.drawerKick) {
            escpos += '\x07'; // Bell character to open drawer (ESC p)
        }
        
        return escpos;
    }

    async processReport(job) {
        const reportData = typeof job.content === 'string' ? 
            JSON.parse(job.content) : job.content;
        
        // Generate HTML report
        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>${reportData.title || 'Report'}</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 20px; }
                    .header { text-align: center; margin-bottom: 30px; }
                    .title { font-size: 24px; font-weight: bold; }
                    .subtitle { font-size: 14px; color: #666; }
                    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
                    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                    th { background-color: #f2f2f2; }
                    .total-row { font-weight: bold; }
                    .footer { margin-top: 50px; font-size: 12px; color: #666; }
                    @media print {
                        .no-print { display: none; }
                    }
                </style>
            </head>
            <body>
                <div class="header">
                    <div class="title">${reportData.title || 'Sales Report'}</div>
                    <div class="subtitle">
                        Period: ${new Date(reportData.startDate).toLocaleDateString()} 
                        to ${new Date(reportData.endDate).toLocaleDateString()}
                    </div>
                    <div class="subtitle">
                        Generated: ${new Date().toLocaleString()}
                    </div>
                </div>
                
                ${this.generateReportTables(reportData)}
                
                <div class="footer">
                    <p>Generated by POS System v1.0</p>
                    <p>Page 1 of 1</p>
                </div>
            </body>
            </html>
        `;
        
        return html;
    }

    generateReportTables(reportData) {
        let tables = '';
        
        if (reportData.summary) {
            tables += `
                <h3>Summary</h3>
                <table>
                    <tr>
                        <th>Metric</th>
                        <th>Value</th>
                    </tr>
                    ${Object.entries(reportData.summary).map(([key, value]) => `
                        <tr>
                            <td>${key.replace(/_/g, ' ').toUpperCase()}</td>
                            <td>${typeof value === 'number' ? value.toFixed(2) : value}</td>
                        </tr>
                    `).join('')}
                </table>
            `;
        }
        
        if (reportData.daily_sales && reportData.daily_sales.length > 0) {
            tables += `
                <h3>Daily Sales</h3>
                <table>
                    <tr>
                        <th>Date</th>
                        <th>Transactions</th>
                        <th>Total Sales</th>
                        <th>Average Ticket</th>
                    </tr>
                    ${reportData.daily_sales.map(day => `
                        <tr>
                            <td>${day.sale_date}</td>
                            <td>${day.transaction_count}</td>
                            <td>$${day.total_sales.toFixed(2)}</td>
                            <td>$${day.avg_ticket.toFixed(2)}</td>
                        </tr>
                    `).join('')}
                </table>
            `;
        }
        
        return tables;
    }

    async processLabel(job) {
        const labelData = typeof job.content === 'string' ? 
            JSON.parse(job.content) : job.content;
        
        // Generate ZPL (Zebra Programming Language) for label printers
        let zpl = '';
        
        // Start label
        zpl += '^XA';
        
        // Set label size
        zpl += `^LL${labelData.height || 200}`;
        
        // Product name
        zpl += `^FO20,20^A0N,30,30^FD${labelData.name}^FS`;
        
        // SKU
        zpl += `^FO20,60^A0N,20,20^FD${labelData.sku}^FS`;
        
        // Price
        zpl += `^FO20,90^A0N,40,40^FD$${labelData.price.toFixed(2)}^FS`;
        
        // Barcode
        if (labelData.barcode) {
            zpl += `^FO20,140^BY2^BCN,60,Y,N,N^FD${labelData.barcode}^FS`;
        }
        
        // End label
        zpl += '^XZ';
        
        return zpl;
    }

    async sendToPrinter(printerName, data, copies = 1) {
        const printer = this.printerConfig.printers[printerName];
        
        if (!printer) {
            throw new Error(`Printer not found: ${printerName}`);
        }
        
        // Update printer status
        this.printerStatus[printerName] = {
            status: 'PRINTING',
            lastJob: new Date().toISOString(),
            copiesPrinted: copies
        };
        
        // Platform-specific printing
        switch (os.platform()) {
            case 'win32':
                await this.printWindows(printer, data, copies);
                break;
            case 'linux':
                await this.printLinux(printer, data, copies);
                break;
            case 'darwin':
                await this.printMac(printer, data, copies);
                break;
            default:
                throw new Error(`Unsupported platform: ${os.platform()}`);
        }
        
        // Update printer status
        this.printerStatus[printerName] = {
            status: 'READY',
            lastJob: new Date().toISOString(),
            totalJobs: (this.printerStatus[printerName]?.totalJobs || 0) + 1
        };
    }

    async printWindows(printer, data, copies) {
        return new Promise((resolve, reject) => {
            // Save to temp file
            const tempFile = path.join(os.tmpdir(), `print_${Date.now()}.tmp`);
            
            // Write data based on type
            if (typeof data === 'string' && data.includes('^XA')) {
                // ZPL data for label printer
                fs.writeFileSync(tempFile, data);
                
                // Use copy command for parallel port
                if (printer.port.startsWith('LPT')) {
                    exec(`copy /B ${tempFile} ${printer.port}`, (error) => {
                        fs.unlinkSync(tempFile);
                        if (error) reject(error);
                        else resolve();
                    });
                } else {
                    // Use print command for network/USB
                    exec(`print /D:${printer.port} ${tempFile}`, (error) => {
                        fs.unlinkSync(tempFile);
                        if (error) reject(error);
                        else resolve();
                    });
                }
            } else {
                // Text/ESC-POS data
                const buffer = Buffer.from(data, 'binary');
                fs.writeFileSync(tempFile, buffer);
                
                // Use different command for ESC/POS
                exec(`copy /B ${tempFile} ${printer.port || 'LPT1'}`, (error) => {
                    fs.unlinkSync(tempFile);
                    if (error) reject(error);
                    else resolve();
                });
            }
        });
    }

    async printLinux(printer, data, copies) {
        return new Promise((resolve, reject) => {
            const tempFile = path.join(os.tmpdir(), `print_${Date.now()}.tmp`);
            
            // Write data
            const buffer = Buffer.from(data, 'binary');
            fs.writeFileSync(tempFile, buffer);
            
            // Use lp command for printing
            let command = `lp -n ${copies} `;
            
            if (printer.port === 'USB') {
                command += `-d ${printer.name || 'THERMAL'} `;
            } else if (printer.port.startsWith('/dev/')) {
                command += `-d ${printer.port} `;
            }
            
            command += tempFile;
            
            exec(command, (error) => {
                fs.unlinkSync(tempFile);
                if (error) reject(error);
                else resolve();
            });
        });
    }

    async printMac(printer, data, copies) {
        return new Promise((resolve, reject) => {
            const tempFile = path.join(os.tmpdir(), `print_${Date.now()}.tmp`);
            
            // Write data
            const buffer = Buffer.from(data, 'binary');
            fs.writeFileSync(tempFile, buffer);
            
            // Use lpr command
            exec(`lpr -# ${copies} -P ${printer.name || 'THERMAL'} ${tempFile}`, (error) => {
                fs.unlinkSync(tempFile);
                if (error) reject(error);
                else resolve();
            });
        });
    }

    centerText(text) {
        const width = this.printerConfig.printers.THERMAL_RECEIPT?.paperWidth || 32;
        const spaces = Math.max(0, Math.floor((width - text.length) / 2));
        return ' '.repeat(spaces) + text;
    }

    formatLine(item, qty, price, total) {
        const itemWidth = 16;
        const qtyWidth = 4;
        const priceWidth = 8;
        const totalWidth = 8;
        
        const itemPart = (item || '').padEnd(itemWidth);
        const qtyPart = (qty || '').padStart(qtyWidth);
        const pricePart = (price || '').padStart(priceWidth);
        const totalPart = (total || '').padStart(totalWidth);
        
        return itemPart + qtyPart + pricePart + totalPart + '\n';
    }

    generateBarcode(data) {
        // Generate Code 128 barcode
        let barcode = '\x1D\x68\x64'; // GS h 100 - Set barcode height
        barcode += '\x1D\x48\x02'; // GS H 2 - Print barcode human readable below
        barcode += '\x1D\x77\x03'; // GS w 3 - Set barcode width
        barcode += '\x1D\x6B\x49'; // GS k 73 - Code 128
        barcode += String.fromCharCode(data.length + 2); // Length
        barcode += '{B'; // Code 128 subset B
        barcode += data;
        barcode += '\x00'; // Null terminator
        
        return barcode;
    }

    async loadTemplate(templateName) {
        if (this.templateCache.has(templateName)) {
            return this.templateCache.get(templateName);
        }
        
        const templateFile = this.printerConfig.templates[templateName];
        
        if (!templateFile) {
            throw new Error(`Template not found: ${templateName}`);
        }
        
        const templatePath = path.join(process.cwd(), 'templates', templateFile);
        
        if (!fs.existsSync(templatePath)) {
            // Create default template directory
            const templateDir = path.join(process.cwd(), 'templates');
            if (!fs.existsSync(templateDir)) {
                fs.mkdirSync(templateDir, { recursive: true });
            }
            
            // Create default template
            const defaultTemplate = this.createDefaultTemplate(templateName);
            fs.writeFileSync(templatePath, defaultTemplate);
        }
        
        const template = fs.readFileSync(templatePath, 'utf8');
        this.templateCache.set(templateName, template);
        
        return template;
    }

    createDefaultTemplate(templateName) {
        switch (templateName) {
            case 'RECEIPT':
                return `RECEIPT TEMPLATE`;
            case 'INVOICE':
                return `INVOICE TEMPLATE`;
            default:
                return `DEFAULT TEMPLATE`;
        }
    }

    logPrintEvent(eventType, details) {
        this.db.run(
            `INSERT INTO system_metrics (metric_name, metric_value, metric_type, unit, tags)
             VALUES (?, ?, ?, ?, ?)`,
            [
                'print_event',
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

    getPrintQueueStatus() {
        return {
            queue_length: this.printQueue.length,
            is_printing: this.isPrinting,
            printers: this.printerStatus,
            next_job: this.printQueue[0] || null
        };
    }

    async getPrintJobHistory(limit = 50) {
        return await this.db.query(
            `SELECT * FROM print_jobs 
             ORDER BY queued_at DESC 
             LIMIT ?`,
            [limit]
        );
    }

    clearPrintQueue() {
        this.printQueue = [];
        this.isPrinting = false;
        
        this.logPrintEvent('QUEUE_CLEARED', {
            timestamp: new Date().toISOString()
        });
    }

    async testPrinter(printerName) {
        const testJob = {
            jobId: `TEST_${Date.now()}`,
            documentType: 'RECEIPT',
            contentType: 'ESC/POS',
            content: JSON.stringify({
                receipt_number: 'TEST123',
                date: new Date().toISOString(),
                cashier: 'TEST USER',
                items: [
                    { name: 'Printer Test Item', quantity: 1, unit_price: 0.01, total_price: 0.01 }
                ],
                subtotal: 0.01,
                tax: 0.00,
                total: 0.01,
                payment_method: 'TEST',
                amount_tendered: 0.01,
                change_given: 0.00
            }),
            printerName: printerName,
            copies: 1,
            priority: 99,
            createdBy: 'SYSTEM',
            referenceId: 'PRINTER_TEST'
        };
        
        return await this.addToPrintQueue(testJob);
    }
}

module.exports = DesignPrintModule;
