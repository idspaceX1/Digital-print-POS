const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const os = require('os');

class DatabaseModule {
    constructor() {
        this.db = null;
        this.performanceLog = [];
        this.queryCount = 0;
        this.startTime = Date.now();
        
        // CPU architecture check for x86
        this.isX86 = os.arch() === 'x32' || os.arch() === 'x64';
        if (!this.isX86) {
            console.error('WARNING: System is not x86 architecture. Some optimizations may not work.');
        }
        
        this.initDatabase();
    }

    initDatabase() {
        const dbPath = path.join(process.cwd(), 'pos_database.db');
        
        // Remove old database for clean start
        if (fs.existsSync(dbPath)) {
            fs.unlinkSync(dbPath);
        }

        this.db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error('Database connection error:', err);
                process.exit(1);
            }
            
            // Enable WAL mode for better concurrency
            this.db.run('PRAGMA journal_mode = WAL;');
            this.db.run('PRAGMA synchronous = NORMAL;');
            this.db.run('PRAGMA cache_size = 10000;'); // 10MB cache
            
            // Create tables with explicit indexes
            this.createTables();
        });
    }

    createTables() {
        const tables = [
            // Products table
            `CREATE TABLE IF NOT EXISTS products (
                product_id INTEGER PRIMARY KEY AUTOINCREMENT,
                sku VARCHAR(50) UNIQUE NOT NULL,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                category VARCHAR(100),
                unit_price DECIMAL(10,2) NOT NULL,
                cost_price DECIMAL(10,2) NOT NULL,
                quantity INTEGER DEFAULT 0,
                min_stock_level INTEGER DEFAULT 10,
                max_stock_level INTEGER DEFAULT 100,
                supplier_id INTEGER,
                barcode VARCHAR(100),
                weight DECIMAL(10,2),
                dimensions VARCHAR(50),
                tax_rate DECIMAL(5,2) DEFAULT 0.0,
                is_active BOOLEAN DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_restock_date DATETIME,
                location VARCHAR(50)
            )`,

            // Inventory transactions
            `CREATE TABLE IF NOT EXISTS inventory_transactions (
                transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER NOT NULL,
                transaction_type VARCHAR(20) NOT NULL, -- 'PURCHASE', 'SALE', 'RETURN', 'ADJUSTMENT', 'WASTE'
                quantity_change INTEGER NOT NULL,
                previous_quantity INTEGER NOT NULL,
                new_quantity INTEGER NOT NULL,
                unit_cost DECIMAL(10,2),
                total_cost DECIMAL(10,2),
                reference_id VARCHAR(100),
                notes TEXT,
                performed_by INTEGER,
                transaction_date DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (product_id) REFERENCES products(product_id)
            )`,

            // Sales transactions
            `CREATE TABLE IF NOT EXISTS sales_transactions (
                sale_id INTEGER PRIMARY KEY AUTOINCREMENT,
                transaction_id VARCHAR(50) UNIQUE NOT NULL,
                cashier_id INTEGER NOT NULL,
                total_amount DECIMAL(10,2) NOT NULL,
                tax_amount DECIMAL(10,2) NOT NULL,
                discount_amount DECIMAL(10,2) DEFAULT 0.0,
                payment_method VARCHAR(20) NOT NULL, -- 'CASH', 'CARD', 'MIXED'
                cash_tendered DECIMAL(10,2),
                change_given DECIMAL(10,2),
                customer_id INTEGER,
                sale_status VARCHAR(20) DEFAULT 'COMPLETED', -- 'COMPLETED', 'REFUNDED', 'VOID'
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                completed_at DATETIME,
                register_id INTEGER,
                receipt_number VARCHAR(50),
                FOREIGN KEY (cashier_id) REFERENCES employees(employee_id)
            )`,

            // Sale items
            `CREATE TABLE IF NOT EXISTS sale_items (
                sale_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
                sale_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                quantity INTEGER NOT NULL,
                unit_price DECIMAL(10,2) NOT NULL,
                discount_percentage DECIMAL(5,2) DEFAULT 0.0,
                tax_amount DECIMAL(10,2) NOT NULL,
                total_price DECIMAL(10,2) NOT NULL,
                cost_price DECIMAL(10,2) NOT NULL,
                profit DECIMAL(10,2) NOT NULL,
                FOREIGN KEY (sale_id) REFERENCES sales_transactions(sale_id),
                FOREIGN KEY (product_id) REFERENCES products(product_id)
            )`,

            // Employees
            `CREATE TABLE IF NOT EXISTS employees (
                employee_id INTEGER PRIMARY KEY AUTOINCREMENT,
                employee_code VARCHAR(50) UNIQUE NOT NULL,
                first_name VARCHAR(100) NOT NULL,
                last_name VARCHAR(100) NOT NULL,
                role VARCHAR(50) NOT NULL, -- 'CASHIER', 'MANAGER', 'ADMIN'
                pin_code VARCHAR(100) NOT NULL,
                email VARCHAR(255),
                phone VARCHAR(20),
                address TEXT,
                hire_date DATE NOT NULL,
                hourly_rate DECIMAL(10,2) NOT NULL,
                is_active BOOLEAN DEFAULT 1,
                permissions TEXT, -- JSON string of permissions
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Employee attendance
            `CREATE TABLE IF NOT EXISTS employee_attendance (
                attendance_id INTEGER PRIMARY KEY AUTOINCREMENT,
                employee_id INTEGER NOT NULL,
                shift_date DATE NOT NULL,
                shift_start DATETIME NOT NULL,
                shift_end DATETIME,
                break_start DATETIME,
                break_end DATETIME,
                total_hours DECIMAL(5,2),
                overtime_hours DECIMAL(5,2) DEFAULT 0.0,
                status VARCHAR(20) DEFAULT 'PRESENT', -- 'PRESENT', 'ABSENT', 'LATE', 'LEAVE'
                notes TEXT,
                clock_in_method VARCHAR(20), -- 'PIN', 'BIOMETRIC', 'CARD'
                clock_out_method VARCHAR(20),
                FOREIGN KEY (employee_id) REFERENCES employees(employee_id)
            )`,

            // Print jobs
            `CREATE TABLE IF NOT EXISTS print_jobs (
                job_id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_type VARCHAR(50) NOT NULL, -- 'RECEIPT', 'REPORT', 'LABEL'
                content_type VARCHAR(50) NOT NULL, -- 'TEXT', 'HTML', 'ESC/POS'
                content BLOB NOT NULL,
                printer_name VARCHAR(100),
                printer_driver VARCHAR(100),
                paper_size VARCHAR(50),
                copies INTEGER DEFAULT 1,
                priority INTEGER DEFAULT 1,
                status VARCHAR(20) DEFAULT 'PENDING', -- 'PENDING', 'PRINTING', 'COMPLETED', 'FAILED'
                error_message TEXT,
                queued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                started_at DATETIME,
                completed_at DATETIME,
                created_by INTEGER,
                reference_id VARCHAR(100)
            )`,

            // System metrics
            `CREATE TABLE IF NOT EXISTS system_metrics (
                metric_id INTEGER PRIMARY KEY AUTOINCREMENT,
                metric_name VARCHAR(100) NOT NULL,
                metric_value DECIMAL(15,4) NOT NULL,
                metric_type VARCHAR(50), -- 'COUNTER', 'GAUGE', 'TIMING'
                unit VARCHAR(20),
                recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                tags TEXT -- JSON string of tags
            )`
        ];

        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku)',
            'CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)',
            'CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)',
            'CREATE INDEX IF NOT EXISTS idx_sales_transaction_id ON sales_transactions(transaction_id)',
            'CREATE INDEX IF NOT EXISTS idx_sales_cashier_date ON sales_transactions(cashier_id, created_at)',
            'CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id)',
            'CREATE INDEX IF NOT EXISTS idx_inventory_transactions_product ON inventory_transactions(product_id, transaction_date)',
            'CREATE INDEX IF NOT EXISTS idx_employee_attendance_date ON employee_attendance(employee_id, shift_date)',
            'CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status, priority)'
        ];

        // Execute table creation
        this.executeBatch(tables, 'Creating tables')
            .then(() => this.executeBatch(indexes, 'Creating indexes'))
            .then(() => this.insertDefaultData())
            .catch(err => console.error('Database initialization error:', err));
    }

    async executeBatch(queries, operationName) {
        const start = process.hrtime.bigint();
        
        for (const query of queries) {
            await new Promise((resolve, reject) => {
                this.db.run(query, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }
        
        const end = process.hrtime.bigint();
        const duration = Number(end - start) / 1000000; // ms
        
        this.logPerformance(operationName, duration);
    }

    logPerformance(operation, duration) {
        this.performanceLog.push({
            timestamp: new Date().toISOString(),
            operation,
            duration,
            queryCount: ++this.queryCount
        });
        
        // Keep only last 1000 entries
        if (this.performanceLog.length > 1000) {
            this.performanceLog.shift();
        }
    }

    insertDefaultData() {
        // Insert default admin employee
        const adminPin = require('crypto').createHash('sha256').update('123456').digest('hex');
        
        const defaultData = [
            `INSERT OR IGNORE INTO employees (employee_code, first_name, last_name, role, pin_code, email, hire_date, hourly_rate, permissions) 
             VALUES ('ADMIN001', 'System', 'Administrator', 'ADMIN', '${adminPin}', 'admin@pos.local', '${new Date().toISOString().split('T')[0]}', 25.00, '["ALL"]')`
        ];

        this.executeBatch(defaultData, 'Inserting default data');
    }

    query(sql, params = []) {
        const start = process.hrtime.bigint();
        
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                const end = process.hrtime.bigint();
                const duration = Number(end - start) / 1000000;
                
                if (err) {
                    this.logPerformance('QUERY_ERROR', duration);
                    reject(err);
                } else {
                    this.logPerformance(`QUERY: ${sql.split(' ')[0]}...`, duration);
                    resolve(rows);
                }
            });
        });
    }

    run(sql, params = []) {
        const start = process.hrtime.bigint();
        
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                const end = process.hrtime.bigint();
                const duration = Number(end - start) / 1000000;
                
                if (err) {
                    this.logPerformance('RUN_ERROR', duration);
                    reject(err);
                } else {
                    this.logPerformance(`RUN: ${sql.split(' ')[0]}...`, duration);
                    resolve({ lastID: this.lastID, changes: this.changes });
                }
            });
        });
    }

    getPerformanceMetrics() {
        const totalRuntime = Date.now() - this.startTime;
        const avgQueryTime = this.performanceLog.reduce((sum, log) => sum + log.duration, 0) / this.performanceLog.length;
        
        return {
            totalQueries: this.queryCount,
            totalRuntime: totalRuntime,
            avgQueryTime: avgQueryTime,
            queriesPerSecond: this.queryCount / (totalRuntime / 1000),
            lastOperations: this.performanceLog.slice(-10),
            architecture: os.arch(),
            platform: os.platform(),
            cpuCount: os.cpus().length
        };
    }

    beginTransaction() {
        return new Promise((resolve, reject) => {
            this.db.run('BEGIN TRANSACTION', (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    commit() {
        return new Promise((resolve, reject) => {
            this.db.run('COMMIT', (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    rollback() {
        return new Promise((resolve, reject) => {
            this.db.run('ROLLBACK', (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    backup(filePath) {
        return new Promise((resolve, reject) => {
            const backupDB = new sqlite3.Database(filePath);
            this.db.backup(backupDB, {
                progress: (p) => {
                    console.log(`Backup progress: ${p.totalPages ? ((p.page * 100) / p.totalPages).toFixed(2) : 0}%`);
                }
            }, (err) => {
                if (err) reject(err);
                else {
                    backupDB.close();
                    resolve();
                }
            });
        });
    }

    close() {
        return new Promise((resolve, reject) => {
            this.db.close((err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
}

module.exports = DatabaseModule;
