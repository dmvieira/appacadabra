// In-App Purchases Service (DISABLED)
// React Native IAP removed due to build issues.
/*
import {
    initConnection,
    endConnection,
    getProducts,
    requestPurchase,
    finishTransaction,
    getAvailablePurchases,
    flushFailedPurchasesCachedAsPendingAndroid,
    purchaseUpdatedListener,
    purchaseErrorListener,
    type Product,
    type Purchase,
    type PurchaseError,
} from 'react-native-iap';
// ... rest of the file content
*/
export const MANA_PRODUCTS = {};
export const ALL_PRODUCT_IDS = [];
export async function initIAP() { return false; }
export async function setupPurchaseListeners() { return () => { }; }
export async function fetchProducts() { return []; }
export async function buyProduct() { }
export async function restorePurchases() { return []; }
export async function closeConnection() { }
