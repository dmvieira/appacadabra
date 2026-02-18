import {
    initConnection,
    endConnection,
    fetchProducts as RNIapFetchProducts,
    requestPurchase,
    finishTransaction,
    purchaseUpdatedListener,
    purchaseErrorListener,
    type Product,
    type Purchase,
    type PurchaseError,
    type Subscription,
} from 'react-native-iap';
import { Platform } from 'react-native';

// Product IDs as defined in Google Play Console
export const MANA_PRODUCTS = {
    MANA_10: 'mana_10',
    MANA_50: 'mana_50',
    MANA_120: 'mana_120',
};

export const ALL_PRODUCT_IDS = Object.values(MANA_PRODUCTS);

let purchaseUpdateSubscription: any = null;
let purchaseErrorSubscription: any = null;

export async function initIAP() {
    try {
        const result = await initConnection();
        console.log('IAP Connection initialized:', result);
        return result;
    } catch (err) {
        console.error('IAP Initialization failed:', err);
        return false;
    }
}

export async function closeConnection() {
    if (purchaseUpdateSubscription) {
        purchaseUpdateSubscription.remove();
        purchaseUpdateSubscription = null;
    }
    if (purchaseErrorSubscription) {
        purchaseErrorSubscription.remove();
        purchaseErrorSubscription = null;
    }
    try {
        await endConnection();
    } catch (err) {
        console.warn('Error closing IAP connection:', err);
    }
}

export async function fetchProducts(): Promise<Product[]> {
    try {
        const result = await RNIapFetchProducts({ skus: ALL_PRODUCT_IDS });
        // @ts-ignore: explicit cast to avoid union type issues, treating all results as Products
        const products: Product[] = result || [];
        console.log('Fetched products:', products);
        return products;
    } catch (err) {
        console.error('Error fetching products:', err);
        return [];
    }
}

export async function requestProductPurchase(productId: string) {
    try {
        await requestPurchase({
            request: {
                apple: { sku: productId },
                google: { skus: [productId] },
            },
            type: 'in-app',
        });
    } catch (err) {
        console.error('Purchase request failed:', err);
        throw err;
    }
}

export function setupPurchaseListeners(
    onPurchaseSuccess: (purchase: Purchase, productId: string) => Promise<void>,
    onPurchaseError: (error: PurchaseError) => void
) {
    // Listener for successful purchases
    purchaseUpdateSubscription = purchaseUpdatedListener(async (purchase: Purchase) => {
        // Ensure we have a valid purchase object
        if (purchase) {
            try {
                // Acknowledge the purchase (required for Android)
                await finishTransaction({ purchase, isConsumable: true });

                // Notify the app to add mana
                await onPurchaseSuccess(purchase, purchase.productId);
            } catch (ackErr) {
                console.error('Error acknowledging purchase:', ackErr);
            }
        }
    });

    // Listener for purchase errors
    purchaseErrorSubscription = purchaseErrorListener((error: PurchaseError) => {
        console.warn('Purchase error:', error);
        onPurchaseError(error);
    });

    return () => {
        if (purchaseUpdateSubscription) {
            purchaseUpdateSubscription.remove();
        }
        if (purchaseErrorSubscription) {
            purchaseErrorSubscription.remove();
        }
    };
}
