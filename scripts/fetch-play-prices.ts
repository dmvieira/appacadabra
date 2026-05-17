import { createSign } from 'node:crypto';
import { request } from 'node:https';
import { URLSearchParams } from 'node:url';

const PACKAGE_NAME = 'ai.appacadabra.app';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

// Priority countries to show in the table (others shown as count)
const PRIORITY_COUNTRIES = ['US', 'BR', 'PT', 'GB', 'IT', 'FR', 'ES'];

function formatPrice(priceMicros: string, currency: string): string {
    const amount = parseInt(priceMicros, 10) / 1_000_000;
    return `${currency} ${amount.toFixed(2)}`;
}

function httpsPost(hostname: string, path: string, body: string, headers: Record<string, string>): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = request({ hostname, path, method: 'POST', headers }, (res) => {
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Parse error: ${data}`)); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function httpsGet(url: string, accessToken: string): Promise<any> {
    const { hostname, pathname, search } = new URL(url);
    return new Promise((resolve, reject) => {
        const req = request(
            { hostname, path: pathname + search, headers: { Authorization: `Bearer ${accessToken}` } },
            (res) => {
                let data = '';
                res.on('data', chunk => (data += chunk));
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Parse error: ${data}`)); }
                });
            }
        );
        req.on('error', reject);
        req.end();
    });
}

async function getAccessToken(serviceAccount: any): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({
        iss: serviceAccount.client_email,
        scope: SCOPE,
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now,
    })).toString('base64url');

    const signingInput = `${header}.${claims}`;
    const sign = createSign('RSA-SHA256');
    sign.update(signingInput);
    const signature = sign.sign(serviceAccount.private_key, 'base64url');
    const jwt = `${signingInput}.${signature}`;

    const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
    }).toString();

    const resp = await httpsPost('oauth2.googleapis.com', '/token', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': String(Buffer.byteLength(body)),
    });

    if (!resp.access_token) throw new Error(`Token exchange failed: ${JSON.stringify(resp)}`);
    return resp.access_token;
}

function moneyToString(money: any): string {
    if (!money) return 'N/A';
    const units = parseInt(money.units || '0', 10);
    const nanos = money.nanos || 0;
    const amount = units + nanos / 1_000_000_000;
    return `${money.currencyCode} ${amount.toFixed(2)}`;
}

async function fetchInAppProducts(accessToken: string): Promise<any[]> {
    // Try new oneTimeProducts API first
    const newUrl = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/oneTimeProducts`;
    const newResp = await httpsGet(newUrl, accessToken);
    if (!newResp.error) {
        return (newResp.oneTimeProducts || []).map((p: any) => {
            const countryPrices: Record<string, string> = {};
            for (const opt of p.purchaseOptions || []) {
                for (const cfg of opt.regionalPricingAndAvailabilityConfigs || []) {
                    if (cfg.price) countryPrices[cfg.regionCode] = moneyToString(cfg.price);
                }
            }
            return { sku: p.productId, countryPrices };
        });
    }

    // Fall back to legacy inappproducts endpoint
    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/inappproducts`;
    const resp = await httpsGet(url, accessToken);
    if (resp.error) throw new Error(`API error: ${JSON.stringify(resp.error)}`);
    return (resp.inappproduct || []).map((p: any) => {
        const countryPrices: Record<string, string> = {};
        for (const [country, price] of Object.entries(p.prices || {})) {
            const { priceMicros, currency } = price as any;
            countryPrices[country] = formatPrice(priceMicros, currency);
        }
        const defaultPrice = p.defaultPrice ? formatPrice(p.defaultPrice.priceMicros, p.defaultPrice.currency) : null;
        if (defaultPrice && !countryPrices['US']) countryPrices['US'] = defaultPrice;
        return { sku: p.sku, countryPrices };
    });
}

function printTable(products: any[]): void {
    const cols = ['Product', ...PRIORITY_COUNTRIES, 'Others'];
    const colWidths = [12, ...PRIORITY_COUNTRIES.map(() => 14), 8];

    const pad = (s: string, w: number) => s.padEnd(w);
    const header = cols.map((c, i) => pad(c, colWidths[i])).join('  ');
    const divider = colWidths.map(w => '─'.repeat(w)).join('  ');

    console.log('\n' + header);
    console.log(divider);

    for (const p of products) {
        const { countryPrices } = p;
        const totalCountries = Object.keys(countryPrices).length;
        const shownCount = PRIORITY_COUNTRIES.filter(c => countryPrices[c]).length;
        const otherCount = totalCountries - shownCount;

        const row = [
            p.sku,
            ...PRIORITY_COUNTRIES.map(c => countryPrices[c] || '—'),
            otherCount > 0 ? `+${otherCount}` : '—',
        ];

        console.log(row.map((v, i) => pad(String(v), colWidths[i])).join('  '));
    }

    console.log();
}

async function main() {
    const saJson = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
    if (!saJson) {
        console.error(
            'Error: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON not set.\n\n' +
            'Obtain it with:\n' +
            '  firebase functions:secrets:access GOOGLE_PLAY_SERVICE_ACCOUNT_JSON\n\n' +
            'Then run:\n' +
            "  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON='...' npm run fetch-play-prices"
        );
        process.exit(1);
    }

    let serviceAccount: any;
    try {
        serviceAccount = JSON.parse(saJson);
    } catch {
        console.error('Error: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON.');
        process.exit(1);
    }

    console.log('Authenticating with Google Play Developer API...');
    const accessToken = await getAccessToken(serviceAccount);

    console.log(`Fetching in-app products for ${PACKAGE_NAME}...`);
    const products = await fetchInAppProducts(accessToken);

    if (products.length === 0) {
        console.log('No in-app products found.');
        return;
    }

    products.sort((a, b) => a.sku.localeCompare(b.sku));
    printTable(products);
    console.log(`Total: ${products.length} product(s)`);
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
