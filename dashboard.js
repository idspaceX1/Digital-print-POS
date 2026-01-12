const os = require('os');
const EventEmitter = require('events');

class DashboardModule extends EventEmitter {
    constructor(database, inventory, cashier, employee) {
        super();
        this.db = database;
        this.inventory = inventory;
        this.cashier = cashier;
        this.employee = employee;
        
        this.realTimeMetrics = {
            sales_today: 0,
            transactions_today: 0,
            average_ticket: 0,
            active_cashiers: 0,
            low_stock_items: 0,
            system_uptime: 0
        };
        
        this.metricHistory = [];
        this.alertThresholds = {
            low_stock: 10,
            high_cpu: 80,
            high_memory: 85,
            low_disk: 10
        };
        
        this.startMetricCollection();
        this.startAlertMonitoring();
    }

    startMetricCollection() {
        // Collect metrics every 30 seconds
        setInterval(() => {
            this.collectSystemMetrics();
            this.updateRealTimeMetrics();
        }, 30000);
        
        // Initial collection
        this.collectSystemMetrics();
        this.updateRealTimeMetrics();
    }

    startAlertMonitoring() {
        // Check alerts every minute
        setInterval(() => {
            this.checkAlerts();
        }, 60000);
    }

    async collectSystemMetrics() {
        const metrics = [];
        const now = new Date().toISOString();
        
        // CPU usage
        const cpuUsage = process.cpuUsage();
        const totalCpuUsage = (cpuUsage.user + cpuUsage.system) / 1000000; // Convert to seconds
        
        metrics.push({
            name: 'cpu_usage',
            value: totalCpuUsage,
            type: 'GAUGE',
            unit: 'seconds',
            timestamp: now,
            tags: JSON.stringify({ pid: process.pid })
        });
        
        // Memory usage
        const memoryUsage = process.memoryUsage();
        
        metrics.push({
            name: 'memory_rss',
            value: memoryUsage.rss / 1024 / 1024,
            type: 'GAUGE',
            unit: 'MB',
            timestamp: now
        });
        
        metrics.push({
            name: 'memory_heap',
            value: memoryUsage.heapUsed / 1024 / 1024,
            type: 'GAUGE',
            unit: 'MB',
            timestamp: now
        });
        
        // System metrics
        metrics.push({
            name: 'system_uptime',
            value: os.uptime(),
            type: 'GAUGE',
            unit: 'seconds',
            timestamp: now
        });
        
        metrics.push({
            name: 'load_average',
            value: os.loadavg()[0],
            type: 'GAUGE',
            unit: 'load',
            timestamp: now
        });
        
        // Database metrics
        const dbMetrics = await this.db.getPerformanceMetrics();
        
        metrics.push({
            name: 'db_queries_per_second',
            value: dbMetrics.queriesPerSecond,
            type: 'GAUGE',
            unit: 'queries/sec',
            timestamp: now
        });
        
        metrics.push({
            name: 'db_avg_query_time',
            value: dbMetrics.avgQueryTime,
            type: 'GAUGE',
            unit: 'ms',
            timestamp: now
        });
        
        // Save metrics to database
        for (const metric of metrics) {
            await this.db.run(
                `INSERT INTO system_metrics 
                 (metric_name, metric_value, metric_type, unit, recorded_at, tags)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    metric.name,
                    metric.value,
                    metric.type,
                    metric.unit,
                    metric.timestamp,
                    metric.tags || null
                ]
            );
            
            // Keep in-memory history
            this.metricHistory.push(metric);
            
            // Keep only last 1000 metrics in memory
            if (this.metricHistory.length > 1000) {
                this.metricHistory.shift();
            }
        }
    }

    async updateRealTimeMetrics() {
        const today = new Date().toISOString().split('T')[0];
        
        // Get today's sales
        const salesData = await this.db.query(
            `SELECT 
                COUNT(*) as transaction_count,
                SUM(total_amount) as total_sales,
                AVG(total_amount) as avg_ticket
             FROM sales_transactions 
             WHERE DATE(created_at) = ?`,
            [today]
        );
        
        if (salesData.length > 0) {
            this.realTimeMetrics.sales_today = salesData[0].total_sales || 0;
            this.realTimeMetrics.transactions_today = salesData[0].transaction_count || 0;
            this.realTimeMetrics.average_ticket = salesData[0].avg_ticket || 0;
        }
        
        // Get active cashiers
        const activeSessions = this.employee.getActiveSessions();
        this.realTimeMetrics.active_cashiers = activeSessions.filter(s => 
            s.role === 'CASHIER' || s.role === 'MANAGER').length;
        
        // Get low stock items
        const lowStock = await this.inventory.checkLowStock();
        this.realTimeMetrics.low_stock_items = lowStock.length;
        
        // System uptime
        this.realTimeMetrics.system_uptime = os.uptime();
        
        // Emit metrics update
        this.emit('metrics_updated', this.realTimeMetrics);
    }

    async checkAlerts() {
        const alerts = [];
        
        // Check low stock
        if (this.realTimeMetrics.low_stock_items > this.alertThresholds.low_stock) {
            alerts.push({
                type: 'LOW_STOCK',
                severity: 'WARNING',
                message: `${this.realTimeMetrics.low_stock_items} items are low on stock`,
                timestamp: new Date().toISOString()
            });
        }
        
        // Check system resources
        const memoryUsage = process.memoryUsage();
        const memoryPercent = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;
        
        if (memoryPercent > this.alertThresholds.high_memory) {
            alerts.push({
                type: 'HIGH_MEMORY',
                severity: 'WARNING',
                message: `Memory usage at ${memoryPercent.toFixed(2)}%`,
                timestamp: new Date().toISOString()
            });
        }
        
        // Check active sessions
        if (this.realTimeMetrics.active_cashiers === 0) {
            alerts.push({
                type: 'NO_ACTIVE_CASHIERS',
                severity: 'INFO',
                message: 'No active cashier sessions',
                timestamp: new Date().toISOString()
            });
        }
        
        // Save alerts
        for (const alert of alerts) {
            await this.db.run(
                `INSERT INTO system_metrics 
                 (metric_name, metric_value, metric_type, unit, recorded_at, tags)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    'system_alert',
                    1,
                    'GAUGE',
                    'alert',
                    alert.timestamp,
                    JSON.stringify(alert)
                ]
            );
            
            // Emit alert
            this.emit('alert_triggered', alert);
        }
        
        return alerts;
    }

    async getSalesDashboard(startDate, endDate) {
        const salesReport = await this.db.query(
            `SELECT 
                DATE(created_at) as sale_date,
                COUNT(*) as transaction_count,
                SUM(total_amount) as total_sales,
                SUM(tax_amount) as total_tax,
                SUM(discount_amount) as total_discount,
                AVG(total_amount) as avg_ticket,
                MIN(total_amount) as min_ticket,
                MAX(total_amount) as max_ticket
             FROM sales_transactions
             WHERE created_at BETWEEN ? AND ?
             GROUP BY DATE(created_at)
             ORDER BY sale_date`,
            [startDate, endDate]
        );
        
        const hourlySales = await this.db.query(
            `SELECT 
                strftime('%H', created_at) as hour,
                COUNT(*) as transaction_count,
                SUM(total_amount) as total_sales
             FROM sales_transactions
             WHERE created_at BETWEEN ? AND ?
             GROUP BY strftime('%H', created_at)
             ORDER BY hour`,
            [startDate, endDate]
        );
        
        const paymentMethods = await this.db.query(
            `SELECT 
                payment_method,
                COUNT(*) as transaction_count,
                SUM(total_amount) as total_sales
             FROM sales_transactions
             WHERE created_at BETWEEN ? AND ?
             GROUP BY payment_method`,
            [startDate, endDate]
        );
        
        const topProducts = await this.db.query(
            `SELECT 
                p.name,
                p.sku,
                SUM(si.quantity) as total_quantity,
                SUM(si.total_price) as total_revenue,
                SUM(si.profit) as total_profit
             FROM sale_items si
             JOIN products p ON si.product_id = p.product_id
             JOIN sales_transactions st ON si.sale_id = st.sale_id
             WHERE st.created_at BETWEEN ? AND ?
             GROUP BY p.product_id
             ORDER BY total_quantity DESC
             LIMIT 10`,
            [startDate, endDate]
        );
        
        const employeePerformance = await this.db.query(
            `SELECT 
                e.employee_id,
                e.first_name || ' ' || e.last_name as employee_name,
                e.role,
                COUNT(st.sale_id) as transaction_count,
                SUM(st.total_amount) as total_sales,
                AVG(st.total_amount) as avg_ticket,
                SUM(si.profit) as total_profit
             FROM sales_transactions st
             JOIN employees e ON st.cashier_id = e.employee_id
             LEFT JOIN (
                 SELECT sale_id, SUM(profit) as profit
                 FROM sale_items
                 GROUP BY sale_id
             ) si ON st.sale_id = si.sale_id
             WHERE st.created_at BETWEEN ? AND ?
             GROUP BY e.employee_id
             ORDER BY total_sales DESC`,
            [startDate, endDate]
        );
        
        return {
            period: {
                start: startDate,
                end: endDate,
                generated: new Date().toISOString()
            },
            summary: {
                total_days: salesReport.length,
                total_transactions: salesReport.reduce((sum, day) => sum + day.transaction_count, 0),
                total_sales: salesReport.reduce((sum, day) => sum + day.total_sales, 0),
                avg_daily_sales: salesReport.reduce((sum, day) => sum + day.total_sales, 0) / salesReport.length,
                best_day: salesReport.reduce((best, day) => day.total_sales > best.total_sales ? day : best, { total_sales: 0 })
            },
            daily_sales: salesReport,
            hourly_pattern: hourlySales,
            payment_methods: paymentMethods,
            top_products: topProducts,
            employee_performance: employeePerformance,
            real_time: this.realTimeMetrics
        };
    }

    async getInventoryDashboard() {
        const inventoryReport = await this.inventory.getInventoryReport(
            new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
            new Date().toISOString()
        );
        
        const stockMovement = await this.db.query(
            `SELECT 
                p.category,
                SUM(CASE WHEN it.transaction_type = 'PURCHASE' THEN it.quantity_change ELSE 0 END) as total_purchased,
                SUM(CASE WHEN it.transaction_type = 'SALE' THEN ABS(it.quantity_change) ELSE 0 END) as total_sold,
                SUM(CASE WHEN it.transaction_type = 'RETURN' THEN it.quantity_change ELSE 0 END) as total_returned,
                SUM(CASE WHEN it.transaction_type = 'WASTE' THEN ABS(it.quantity_change) ELSE 0 END) as total_waste
             FROM inventory_transactions it
             JOIN products p ON it.product_id = p.product_id
             WHERE it.transaction_date >= date('now', '-30 day')
             GROUP BY p.category
             ORDER BY total_sold DESC`
        );
        
        const agingInventory = await this.db.query(
            `SELECT 
                p.product_id,
                p.sku,
                p.name,
                p.category,
                p.quantity,
                p.cost_price,
                p.unit_price,
                p.location,
                MAX(it.transaction_date) as last_movement,
                julianday('now') - julianday(MAX(it.transaction_date)) as days_since_movement
             FROM products p
             LEFT JOIN inventory_transactions it ON p.product_id = it.product_id
             WHERE p.quantity > 0
             GROUP BY p.product_id
             HAVING days_since_movement > 90 OR days_since_movement IS NULL
             ORDER BY days_since_movement DESC
             LIMIT 20`
        );
        
        return {
            generated: new Date().toISOString(),
            summary: inventoryReport.summary,
            categories: stockMovement,
            aging_inventory: agingInventory,
            low_stock_items: inventoryReport.products.filter(p => 
                p.current_stock <= p.min_stock_level),
            excess_stock_items: inventoryReport.products.filter(p => 
                p.current_stock > p.max_stock_level)
        };
    }

    async getEmployeeDashboard(startDate, endDate) {
        const attendanceSummary = await this.db.query(
            `SELECT 
                e.employee_id,
                e.first_name || ' ' || e.last_name as employee_name,
                e.role,
                COUNT(ea.attendance_id) as days_present,
                SUM(ea.total_hours) as total_hours,
                SUM(ea.overtime_hours) as overtime_hours,
                AVG(ea.total_hours) as avg_daily_hours
             FROM employees e
             LEFT JOIN employee_attendance ea ON e.employee_id = ea.employee_id
                AND ea.shift_date BETWEEN ? AND ?
             WHERE e.is_active = 1
             GROUP BY e.employee_id
             ORDER BY e.role, e.last_name`,
            [startDate, endDate]
        );
        
        const lateArrivals = await this.db.query(
            `SELECT 
                ea.employee_id,
                e.first_name || ' ' || e.last_name as employee_name,
                ea.shift_date,
                ea.shift_start,
                TIME(ea.shift_start) as clock_in_time,
                CASE 
                    WHEN TIME(ea.shift_start) > '06:15:00' AND e.role = 'MORNING' THEN 'LATE'
                    WHEN TIME(ea.shift_start) > '14:15:00' AND e.role = 'AFTERNOON' THEN 'LATE'
                    WHEN TIME(ea.shift_start) > '22:15:00' AND e.role = 'NIGHT' THEN 'LATE'
                    ELSE 'ON_TIME'
                END as status
             FROM employee_attendance ea
             JOIN employees e ON ea.employee_id = e.employee_id
             WHERE ea.shift_date BETWEEN ? AND ?
             ORDER BY ea.shift_date DESC`,
            [startDate, endDate]
        );
        
        const payrollSummary = [];
        
        for (const employee of attendanceSummary) {
            if (employee.days_present > 0) {
                const payroll = await this.employee.calculatePayroll(
                    employee.employee_id,
                    startDate,
                    endDate
                );
                payrollSummary.push(payroll);
            }
        }
        
        return {
            period: {
                start: startDate,
                end: endDate
            },
            employee_summary: attendanceSummary,
            attendance_issues: {
                late_arrivals: lateArrivals.filter(r => r.status === 'LATE'),
                total_late: lateArrivals.filter(r => r.status === 'LATE').length
            },
            payroll_summary: payrollSummary,
            active_sessions: this.employee.getActiveSessions()
        };
    }

    async getSystemDashboard() {
        const systemMetrics = await this.db.query(
            `SELECT 
                metric_name,
                AVG(metric_value) as avg_value,
                MAX(metric_value) as max_value,
                MIN(metric_value) as min_value,
                COUNT(*) as samples
             FROM system_metrics
             WHERE recorded_at >= datetime('now', '-1 hour')
             GROUP BY metric_name
             ORDER BY metric_name`
        );
        
        const recentAlerts = await this.db.query(
            `SELECT tags
             FROM system_metrics
             WHERE metric_name = 'system_alert'
                AND recorded_at >= datetime('now', '-24 hours')
             ORDER BY recorded_at DESC
             LIMIT 20`
        );
        
        const dbPerformance = await this.db.getPerformanceMetrics();
        
        // Current system state
        const memoryUsage = process.memoryUsage();
        const cpuUsage = process.cpuUsage();
        
        return {
            timestamp: new Date().toISOString(),
            system_info: {
                arch: os.arch(),
                platform: os.platform(),
                release: os.release(),
                cpus: os.cpus().length,
                total_memory: os.totalmem() / 1024 / 1024 / 1024, // GB
                free_memory: os.freemem() / 1024 / 1024 / 1024, // GB
                uptime: os.uptime()
            },
            process_info: {
                pid: process.pid,
                uptime: process.uptime(),
                memory: {
                    rss: memoryUsage.rss / 1024 / 1024, // MB
                    heap_total: memoryUsage.heapTotal / 1024 / 1024, // MB
                    heap_used: memoryUsage.heapUsed / 1024 / 1024, // MB
                    external: memoryUsage.external / 1024 / 1024 // MB
                },
                cpu: {
                    user: cpuUsage.user / 1000000, // seconds
                    system: cpuUsage.system / 1000000 // seconds
                }
            },
            database_performance: dbPerformance,
            recent_metrics: systemMetrics,
            recent_alerts: recentAlerts.map(r => JSON.parse(r.tags)),
            real_time_metrics: this.realTimeMetrics
        };
    }

    async generateReport(reportType, parameters) {
        const reports = {
            'SALES_SUMMARY': () => this.getSalesDashboard(
                parameters.startDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
                parameters.endDate || new Date().toISOString()
            ),
            'INVENTORY_STATUS': () => this.getInventoryDashboard(),
            'EMPLOYEE_PERFORMANCE': () => this.getEmployeeDashboard(
                parameters.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
                parameters.endDate || new Date().toISOString()
            ),
            'SYSTEM_HEALTH': () => this.getSystemDashboard()
        };
        
        if (!reports[reportType]) {
            throw new Error(`Unknown report type: ${reportType}`);
        }
        
        const report = await reports[reportType]();
        
        // Log report generation
        await this.db.run(
            `INSERT INTO system_metrics 
             (metric_name, metric_value, metric_type, unit, recorded_at, tags)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                'report_generated',
                1,
                'COUNTER',
                'report',
                new Date().toISOString(),
                JSON.stringify({
                    report_type: reportType,
                    parameters: parameters,
                    generated_at: new Date().toISOString()
                })
            ]
        );
        
        return report;
    }

    getRealTimeMetrics() {
        return {
            ...this.realTimeMetrics,
            timestamp: new Date().toISOString(),
            active_sessions: this.employee.getActiveSessions().length
        };
    }

    getMetricHistory(metricName, limit = 100) {
        return this.metricHistory
            .filter(m => m.name === metricName)
            .slice(-limit);
    }

    async exportDashboardData(format = 'JSON') {
        const data = {
            sales: await this.getSalesDashboard(
                new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
                new Date().toISOString()
            ),
            inventory: await this.getInventoryDashboard(),
            employees: await this.getEmployeeDashboard(
                new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
                new Date().toISOString()
            ),
            system: await this.getSystemDashboard(),
            generated: new Date().toISOString()
        };
        
        if (format === 'CSV') {
            // Convert to CSV format (simplified)
            return this.convertToCSV(data);
        }
        
        return data;
    }

    convertToCSV(data) {
        // Simplified CSV conversion
        let csv = '';
        
        // Sales data
        csv += 'SALES DATA\n';
        csv += 'Date,Transactions,Total Sales,Avg Ticket\n';
        if (data.sales.daily_sales) {
            data.sales.daily_sales.forEach(day => {
                csv += `${day.sale_date},${day.transaction_count},${day.total_sales},${day.avg_ticket}\n`;
            });
        }
        
        csv += '\nINVENTORY SUMMARY\n';
        csv += 'SKU,Name,Category,Stock,Min Stock,Max Stock\n';
        if (data.inventory.summary && data.inventory.summary.products) {
            data.inventory.summary.products.forEach(product => {
                csv += `${product.sku},${product.name},${product.category},${product.current_stock},${product.min_stock_level},${product.max_stock_level}\n`;
            });
        }
        
        return csv;
    }
}

module.exports = DashboardModule;
