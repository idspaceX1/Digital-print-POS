const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

class SetupScript {
    constructor() {
        this.requiredDirs = [
            'templates',
            'backups',
            'logs',
            'reports',
            'config'
        ];
        
        this.requiredFiles = [
            'printer-config.json',
            'system-config.json'
        ];
    }

    async run() {
        console.log('=== POS System Setup ===\n');
        
        // Check Node.js version
        const nodeVersion = process.version;
        console.log(`Node.js version: ${nodeVersion}`);
        
        if (parseInt(nodeVersion.replace('v', '').split('.')[0]) < 14) {
            console.error('❌ Node.js 14 or higher is required');
            process.exit(1);
        }
        
        // Check architecture
        const arch = process.arch;
        console.log(`Architecture: ${arch}`);
        
        if (!['x64', 'ia32'].includes(arch)) {
            console.warn('⚠️  System is not x86 architecture. Some features may not work optimally.');
        }
        
        // Create directories
        console.log('\nCreating directories...');
        for (const dir of this.requiredDirs) {
            const dirPath = path.join(process.cwd(), dir);
            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
                console.log(`✅ Created: ${dir}`);
            } else {
                console.log(`✓ Exists: ${dir}`);
            }
        }
        
        // Create configuration files
        console.log('\nCreating configuration files...');
        
        // Printer config
        const printerConfig = {
            defaultPrinter: 'THERMAL_RECEIPT',
            companyName: 'YOUR STORE NAME',
            address: '123 Main Street',
            phone: '(555) 123-4567',
            taxId: 'TAX-123456789',
            printers: {
                'THERMAL_RECEIPT': {
                    type: 'ESC/POS',
                    port: 'USB',
                    baudRate: 19200,
                    paperWidth: 48,
                    characterSet: 'PC437',
                    autoCut: true,
                    drawerKick: true
                }
            }
        };
        
        fs.writeFileSync(
            path.join(process.cwd(), 'printer-config.json'),
            JSON.stringify(printerConfig, null, 2)
        );
        console.log('✅ Created: printer-config.json');
        
        // System config
        const systemConfig = {
            system: {
                name: 'POS System',
                version: '1.0.0',
                autoBackup: true,
                backupInterval: 24, // hours
                logRetention: 30 // days
            },
            business: {
                name: 'Retail Store',
                address: '123 Main Street',
                phone: '(555) 123-4567',
                taxRate: 8.5,
                currency: 'USD',
                timezone: 'America/New_York'
            },
            security: {
                sessionTimeout: 480, // minutes
                maxLoginAttempts: 3,
                passwordExpiry: 90 // days
            },
            inventory: {
                lowStockThreshold: 10,
                reorderPoint: 20,
                autoReorder: false,
                barcodePrefix: 'SKU'
            }
        };
        
        fs.writeFileSync(
            path.join(process.cwd(), 'system-config.json'),
            JSON.stringify(systemConfig, null, 2)
        );
        console.log('✅ Created: system-config.json');
        
        // Create default templates
        console.log('\nCreating default templates...');
        
        const templates = {
            'receipt-template.html': `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Receipt</title>
    <style>
        body { font-family: monospace; width: 300px; margin: 0 auto; }
        .header { text-align: center; }
        .item { display: flex; justify-content: space-between; }
        .total { font-weight: bold; }
        .footer { text-align: center; margin-top: 20px; }
    </style>
</head>
<body>
    <div class="header">
        <h2>{{companyName}}</h2>
        <p>{{address}}</p>
        <p>{{phone}}</p>
    </div>
    <hr>
    <p>Receipt: {{receiptNumber}}</p>
    <p>Date: {{date}}</p>
    <p>Cashier: {{cashier}}</p>
    <hr>
    {{#items}}
    <div class="item">
        <span>{{name}} x{{quantity}}</span>
        <span>${{total}}</span>
    </div>
    {{/items}}
    <hr>
    <div class="item">
        <span>Subtotal:</span>
        <span>${{subtotal}}</span>
    </div>
    <div class="item">
        <span>Tax:</span>
        <span>${{tax}}</span>
    </div>
    <div class="item total">
        <span>TOTAL:</span>
        <span>${{total}}</span>
    </div>
    <hr>
    <div class="footer">
        <p>Thank you for your business!</p>
    </div>
</body>
</html>`
        };
        
        for (const [filename, content] of Object.entries(templates)) {
            const filePath = path.join(process.cwd(), 'templates', filename);
            fs.writeFileSync(filePath, content.trim());
            console.log(`✅ Created: templates/${filename}`);
        }
        
        // Install dependencies
        console.log('\nInstalling dependencies...');
        exec('npm install', (error, stdout, stderr) => {
            if (error) {
                console.error(`❌ Failed to install dependencies: ${error.message}`);
                return;
            }
            
            console.log(stdout);
            console.log('✅ Dependencies installed');
            
            // Create admin user
            console.log('\n=== Setup Complete ===');
            console.log('\nTo create an admin user, run:');
            console.log('  node create-admin.js');
            console.log('\nTo start the system, run:');
            console.log('  node app.js');
            console.log('\nDefault admin PIN: 123456');
            console.log('\n⚠️  IMPORTANT: Change default passwords immediately!');
        });
    }
}

// Run setup
if (require.main === module) {
    const setup = new SetupScript();
    setup.run();
}

module.exports = SetupScript;
