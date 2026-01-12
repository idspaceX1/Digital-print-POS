const crypto = require('crypto');
const EventEmitter = require('events');

class EmployeeModule extends EventEmitter {
    constructor(database) {
        super();
        this.db = database;
        this.activeSessions = new Map();
        this.attendanceCache = new Map();
        this.shiftSchedules = new Map();
        
        this.setupShiftManagement();
        this.startShiftRotation();
    }

    setupShiftManagement() {
        // Define shift schedules
        this.shiftSchedules.set('MORNING', {
            start: '06:00',
            end: '14:00',
            break_start: '10:00',
            break_end: '10:30'
        });
        
        this.shiftSchedules.set('AFTERNOON', {
            start: '14:00',
            end: '22:00',
            break_start: '18:00',
            break_end: '18:30'
        });
        
        this.shiftSchedules.set('NIGHT', {
            start: '22:00',
            end: '06:00',
            break_start: '02:00',
            break_end: '02:30'
        });
    }

    startShiftRotation() {
        // Check for shift changes every minute
        setInterval(() => {
            this.checkShiftChanges();
        }, 60000);
    }

    async authenticate(employeeCode, pinCode) {
        const hashedPin = crypto.createHash('sha256').update(pinCode).digest('hex');
        
        const employees = await this.db.query(
            `SELECT * FROM employees 
             WHERE employee_code = ? 
             AND pin_code = ? 
             AND is_active = 1`,
            [employeeCode, hashedPin]
        );

        if (employees.length === 0) {
            this.logSecurityEvent('AUTH_FAILED', {
                employeeCode: employeeCode,
                reason: 'Invalid credentials'
            });
            throw new Error('Invalid credentials');
        }

        const employee = employees[0];
        
        // Check if already logged in
        if (this.activeSessions.has(employee.employee_id)) {
            throw new Error('Employee already logged in');
        }

        // Record login
        await this.recordLogin(employee.employee_id);

        // Create session
        const sessionId = crypto.randomBytes(32).toString('hex');
        const session = {
            sessionId: sessionId,
            employeeId: employee.employee_id,
            employeeCode: employee.employee_code,
            role: employee.role,
            permissions: JSON.parse(employee.permissions || '[]'),
            loginTime: new Date().toISOString(),
            lastActivity: Date.now(),
            ipAddress: '127.0.0.1' // Would be actual IP in production
        };

        this.activeSessions.set(sessionId, session);

        this.logSecurityEvent('AUTH_SUCCESS', {
            employeeId: employee.employee_id,
            role: employee.role,
            sessionId: sessionId
        });

        this.emit('employee_logged_in', {
            employee: employee,
            session: session
        });

        return {
            sessionId: sessionId,
            employee: {
                employee_id: employee.employee_id,
                employee_code: employee.employee_code,
                first_name: employee.first_name,
                last_name: employee.last_name,
                role: employee.role,
                permissions: JSON.parse(employee.permissions || '[]')
            }
        };
    }

    async recordLogin(employeeId) {
        const today = new Date().toISOString().split('T')[0];
        
        // Check for existing attendance record
        const existing = await this.db.query(
            'SELECT * FROM employee_attendance WHERE employee_id = ? AND shift_date = ?',
            [employeeId, today]
        );

        if (existing.length > 0) {
            // Update existing record
            await this.db.run(
                `UPDATE employee_attendance 
                 SET shift_start = CURRENT_TIMESTAMP, 
                     status = 'PRESENT',
                     clock_in_method = 'PIN'
                 WHERE attendance_id = ?`,
                [existing[0].attendance_id]
            );
        } else {
            // Create new attendance record
            const shiftType = this.determineShiftType();
            const shiftSchedule = this.shiftSchedules.get(shiftType);
            
            await this.db.run(
                `INSERT INTO employee_attendance (
                    employee_id, shift_date, shift_start, 
                    break_start, break_end, shift_end,
                    status, clock_in_method
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    employeeId,
                    today,
                    new Date().toISOString(),
                    shiftSchedule ? this.getTimeForToday(shiftSchedule.break_start) : null,
                    shiftSchedule ? this.getTimeForToday(shiftSchedule.break_end) : null,
                    shiftSchedule ? this.getTimeForToday(shiftSchedule.end) : null,
                    'PRESENT',
                    'PIN'
                ]
            );
        }

        this.attendanceCache.delete(`${employeeId}_${today}`);
    }

    determineShiftType() {
        const hour = new Date().getHours();
        
        if (hour >= 6 && hour < 14) return 'MORNING';
        if (hour >= 14 && hour < 22) return 'AFTERNOON';
        return 'NIGHT';
    }

    getTimeForToday(timeStr) {
        const [hours, minutes] = timeStr.split(':').map(Number);
        const date = new Date();
        date.setHours(hours, minutes, 0, 0);
        
        // If time is before current time and it's night shift, add one day
        if (date < new Date() && hours < 6) {
            date.setDate(date.getDate() + 1);
        }
        
        return date.toISOString();
    }

    async logout(sessionId) {
        const session = this.activeSessions.get(sessionId);
        
        if (!session) {
            throw new Error('Invalid session');
        }

        // Record logout
        await this.recordLogout(session.employeeId);

        this.activeSessions.delete(sessionId);

        this.logSecurityEvent('LOGOUT', {
            employeeId: session.employeeId,
            sessionId: sessionId,
            duration: Date.now() - session.lastActivity
        });

        this.emit('employee_logged_out', {
            employeeId: session.employeeId,
            sessionId: sessionId
        });

        return { success: true };
    }

    async recordLogout(employeeId) {
        const today = new Date().toISOString().split('T')[0];
        
        await this.db.run(
            `UPDATE employee_attendance 
             SET shift_end = CURRENT_TIMESTAMP,
                 clock_out_method = 'PIN',
                 total_hours = ROUND(
                     (strftime('%s', CURRENT_TIMESTAMP) - strftime('%s', shift_start)) / 3600.0, 
                     2
                 )
             WHERE employee_id = ? 
             AND shift_date = ? 
             AND shift_end IS NULL`,
            [employeeId, today]
        );

        this.attendanceCache.delete(`${employeeId}_${today}`);
    }

    async addEmployee(employeeData) {
        // Validate required fields
        const requiredFields = ['employee_code', 'first_name', 'last_name', 'role', 'pin_code', 'hire_date', 'hourly_rate'];
        
        for (const field of requiredFields) {
            if (!employeeData[field]) {
                throw new Error(`Missing required field: ${field}`);
            }
        }

        // Hash PIN code
        const hashedPin = crypto.createHash('sha256').update(employeeData.pin_code).digest('hex');

        // Default permissions based on role
        const defaultPermissions = this.getDefaultPermissions(employeeData.role);

        try {
            const result = await this.db.run(
                `INSERT INTO employees (
                    employee_code, first_name, last_name, role, pin_code,
                    email, phone, address, hire_date, hourly_rate, permissions
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    employeeData.employee_code,
                    employeeData.first_name,
                    employeeData.last_name,
                    employeeData.role,
                    hashedPin,
                    employeeData.email || '',
                    employeeData.phone || '',
                    employeeData.address || '',
                    employeeData.hire_date,
                    employeeData.hourly_rate,
                    JSON.stringify(defaultPermissions)
                ]
            );

            this.logSecurityEvent('EMPLOYEE_ADDED', {
                employeeId: result.lastID,
                employeeCode: employeeData.employee_code,
                role: employeeData.role
            });

            return result.lastID;
        } catch (error) {
            if (error.message.includes('UNIQUE constraint failed')) {
                throw new Error('Employee code already exists');
            }
            throw error;
        }
    }

    getDefaultPermissions(role) {
        const permissions = {
            'CASHIER': [
                'PROCESS_SALES',
                'VIEW_PRODUCTS',
                'VIEW_INVENTORY',
                'PROCESS_RETURNS',
                'VIEW_OWN_SALES'
            ],
            'MANAGER': [
                'PROCESS_SALES',
                'VIEW_PRODUCTS',
                'MANAGE_INVENTORY',
                'PROCESS_RETURNS',
                'VIEW_REPORTS',
                'MANAGE_EMPLOYEES',
                'VOID_TRANSACTIONS',
                'APPLY_DISCOUNTS',
                'VIEW_FINANCIALS'
            ],
            'ADMIN': ['ALL']
        };

        return permissions[role] || permissions['CASHIER'];
    }

    async updateEmployee(employeeId, updateData) {
        // Build dynamic update query
        const fields = [];
        const values = [];
        
        const allowedFields = ['first_name', 'last_name', 'email', 'phone', 'address', 
                              'hourly_rate', 'role', 'permissions', 'is_active'];
        
        for (const [field, value] of Object.entries(updateData)) {
            if (allowedFields.includes(field)) {
                fields.push(`${field} = ?`);
                
                // Special handling for certain fields
                if (field === 'permissions') {
                    values.push(JSON.stringify(value));
                } else if (field === 'role' && value) {
                    // Update permissions when role changes
                    const permissions = this.getDefaultPermissions(value);
                    fields.push('permissions = ?');
                    values.push(JSON.stringify(permissions));
                    values.push(value);
                } else {
                    values.push(value);
                }
            }
        }
        
        if (fields.length === 0) {
            throw new Error('No valid fields to update');
        }
        
        values.push(employeeId);
        
        const sql = `UPDATE employees 
                     SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
                     WHERE employee_id = ?`;
        
        const result = await this.db.run(sql, values);
        
        if (result.changes === 0) {
            throw new Error('Employee not found');
        }
        
        this.logSecurityEvent('EMPLOYEE_UPDATED', {
            employeeId: employeeId,
            updatedFields: Object.keys(updateData)
        });
        
        return result;
    }

    async getEmployee(employeeId) {
        const employees = await this.db.query(
            `SELECT employee_id, employee_code, first_name, last_name, 
                    role, email, phone, address, hire_date, 
                    hourly_rate, is_active, permissions, 
                    created_at, updated_at
             FROM employees WHERE employee_id = ?`,
            [employeeId]
        );
        
        if (employees.length === 0) {
            return null;
        }
        
        const employee = employees[0];
        employee.permissions = JSON.parse(employee.permissions || '[]');
        
        return employee;
    }

    async getEmployees(filters = {}) {
        let sql = `SELECT employee_id, employee_code, first_name, last_name, 
                          role, email, phone, hire_date, hourly_rate, 
                          is_active, created_at
                   FROM employees WHERE 1=1`;
        const params = [];
        
        if (filters.role) {
            sql += ' AND role = ?';
            params.push(filters.role);
        }
        
        if (filters.is_active !== undefined) {
            sql += ' AND is_active = ?';
            params.push(filters.is_active ? 1 : 0);
        }
        
        if (filters.search) {
            sql += ' AND (employee_code LIKE ? OR first_name LIKE ? OR last_name LIKE ?)';
            const searchTerm = `%${filters.search}%`;
            params.push(searchTerm, searchTerm, searchTerm);
        }
        
        sql += ' ORDER BY last_name, first_name';
        
        if (filters.limit) {
            sql += ' LIMIT ?';
            params.push(filters.limit);
        }
        
        return await this.db.query(sql, params);
    }

    async getAttendance(employeeId, startDate, endDate) {
        const cacheKey = `${employeeId}_${startDate}_${endDate}`;
        
        if (this.attendanceCache.has(cacheKey)) {
            const cached = this.attendanceCache.get(cacheKey);
            if (Date.now() - cached.timestamp < 300000) { // 5 minute cache
                return cached.data;
            }
        }
        
        const attendance = await this.db.query(
            `SELECT attendance_id, employee_id, shift_date, shift_start, 
                    shift_end, break_start, break_end, total_hours,
                    overtime_hours, status, notes
             FROM employee_attendance 
             WHERE employee_id = ? 
             AND shift_date BETWEEN ? AND ?
             ORDER BY shift_date DESC`,
            [employeeId, startDate, endDate]
        );
        
        this.attendanceCache.set(cacheKey, {
            data: attendance,
            timestamp: Date.now()
        });
        
        return attendance;
    }

    async calculatePayroll(employeeId, startDate, endDate) {
        const attendance = await this.getAttendance(employeeId, startDate, endDate);
        const employee = await this.getEmployee(employeeId);
        
        if (!employee) {
            throw new Error('Employee not found');
        }
        
        let totalRegularHours = 0;
        let totalOvertimeHours = 0;
        
        for (const record of attendance) {
            if (record.total_hours) {
                const regularHours = Math.min(record.total_hours, 8);
                const overtimeHours = Math.max(record.total_hours - 8, 0);
                
                totalRegularHours += regularHours;
                totalOvertimeHours += overtimeHours + (record.overtime_hours || 0);
            }
        }
        
        const regularPay = totalRegularHours * employee.hourly_rate;
        const overtimePay = totalOvertimeHours * employee.hourly_rate * 1.5;
        const totalPay = regularPay + overtimePay;
        
        // Calculate deductions (simplified)
        const taxRate = 0.15;
        const taxDeduction = totalPay * taxRate;
        const netPay = totalPay - taxDeduction;
        
        return {
            employee: {
                id: employee.employee_id,
                name: `${employee.first_name} ${employee.last_name}`,
                employee_code: employee.employee_code
            },
            period: {
                start: startDate,
                end: endDate
            },
            hours: {
                regular: totalRegularHours,
                overtime: totalOvertimeHours,
                total: totalRegularHours + totalOvertimeHours
            },
            rates: {
                regular: employee.hourly_rate,
                overtime: employee.hourly_rate * 1.5
            },
            earnings: {
                regular: regularPay,
                overtime: overtimePay,
                total: totalPay
            },
            deductions: {
                tax: taxDeduction,
                total: taxDeduction
            },
            net_pay: netPay,
            attendance_records: attendance.length
        };
    }

    async checkShiftChanges() {
        const now = new Date();
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();
        
        // Check if it's shift change time (15 minutes before shift end)
        for (const [shiftType, schedule] of this.shiftSchedules.entries()) {
            const [endHour, endMinute] = schedule.end.split(':').map(Number);
            
            if (currentHour === endHour && currentMinute >= 45) {
                // Shift ending soon, notify employees
                this.emit('shift_ending', {
                    shift: shiftType,
                    endingTime: schedule.end,
                    currentTime: `${currentHour.toString().padStart(2, '0')}:${currentMinute.toString().padStart(2, '0')}`
                });
            }
        }
    }

    validateSession(sessionId, requiredPermission = null) {
        const session = this.activeSessions.get(sessionId);
        
        if (!session) {
            return { valid: false, reason: 'Session not found' };
        }
        
        // Check session timeout (8 hours)
        if (Date.now() - session.lastActivity > 8 * 60 * 60 * 1000) {
            this.activeSessions.delete(sessionId);
            return { valid: false, reason: 'Session expired' };
        }
        
        // Update last activity
        session.lastActivity = Date.now();
        
        // Check permission if required
        if (requiredPermission) {
            if (!session.permissions.includes('ALL') && 
                !session.permissions.includes(requiredPermission)) {
                return { 
                    valid: false, 
                    reason: 'Insufficient permissions',
                    required: requiredPermission,
                    has: session.permissions 
                };
            }
        }
        
        return { 
            valid: true, 
            session: session,
            employeeId: session.employeeId,
            role: session.role
        };
    }

    logSecurityEvent(eventType, details) {
        this.db.run(
            `INSERT INTO system_metrics (metric_name, metric_value, metric_type, unit, tags)
             VALUES (?, ?, ?, ?, ?)`,
            [
                'security_event',
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

    getActiveSessions() {
        return Array.from(this.activeSessions.values()).map(session => ({
            sessionId: session.sessionId,
            employeeId: session.employeeId,
            employeeCode: session.employeeCode,
            role: session.role,
            loginTime: session.loginTime,
            lastActivity: new Date(session.lastActivity).toISOString(),
            duration: Date.now() - session.lastActivity
        }));
    }

    async terminateSession(sessionId, reason = 'ADMIN_TERMINATION') {
        const session = this.activeSessions.get(sessionId);
        
        if (!session) {
            return false;
        }
        
        // Record logout if employee was logged in
        await this.recordLogout(session.employeeId);
        
        this.activeSessions.delete(sessionId);
        
        this.logSecurityEvent('SESSION_TERMINATED', {
            sessionId: sessionId,
            employeeId: session.employeeId,
            reason: reason
        });
        
        return true;
    }
}

module.exports = EmployeeModule;
