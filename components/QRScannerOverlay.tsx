import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Modal, Dimensions } from 'react-native';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import { useBridgeUIStore } from '../lib/bridgeUIStore';
import { Ionicons } from '@expo/vector-icons';
import { createCallbackScript } from '../lib/bridges/injectedJS';
import { WebView } from 'react-native-webview';

interface QRScannerOverlayProps {
    webviewRef: React.RefObject<WebView | null>;
}

export default function QRScannerOverlay({ webviewRef: propWebviewRef }: QRScannerOverlayProps) {
    const { isScannerOpen, scannerCallback, closeScanner, webViewRef: storeWebViewRef } = useBridgeUIStore();

    // Prefer prop ref (scoped to this RunnerContent), fall back to store ref
    const webviewRef = propWebviewRef || storeWebViewRef;

    const [permission, requestPermission] = useCameraPermissions();
    const [scanned, setScanned] = useState(false);

    useEffect(() => {
        if (isScannerOpen && !permission?.granted) {
            requestPermission();
        }
        if (isScannerOpen) {
            setScanned(false);
            console.log('[QRScannerOverlay] Scanner opened. Ref exists:', !!webviewRef?.current);
        }
    }, [isScannerOpen, permission]);

    const handleBarCodeScanned = ({ type, data }: { type: string; data: string }) => {
        if (scanned) return;
        setScanned(true);
        console.log('[QRScannerOverlay] Scanned:', type, data);
        console.log('[QRScannerOverlay] Callback:', scannerCallback);
        console.log('[QRScannerOverlay] WebView Ref exists:', !!webviewRef?.current);

        // Send data back to WebView
        if (scannerCallback && webviewRef?.current) {
            // Success: send data
            const script = createCallbackScript(scannerCallback, true, data);
            webviewRef.current.injectJavaScript(script);
            console.log('[QRScannerOverlay] Injected script');
        } else {
            console.warn('[QRScannerOverlay] Failed to inject: Missing callback or ref', {
                hasCallback: !!scannerCallback,
                hasRef: !!webviewRef,
                hasRefCurrent: !!webviewRef?.current
            });
        }

        closeScanner();
    };

    const handleClose = () => {
        // Cancelled by user
        if (scannerCallback && webviewRef.current) {
            // Error/Cancel: send null or specific error
            const script = createCallbackScript(scannerCallback, false, "Cancelled by user");
            webviewRef.current.injectJavaScript(script);
        }
        closeScanner();
    };

    if (!isScannerOpen) return null;

    if (!permission) {
        // Camera permissions are still loading.
        return <View />;
    }


    return (
        <Modal visible={true} transparent={true} animationType="slide" onRequestClose={() => closeScanner()}>
            <View style={StyleSheet.absoluteFill}>
                <CameraView
                    style={StyleSheet.absoluteFill}
                    facing="back"
                    onBarcodeScanned={handleBarCodeScanned}
                    barcodeScannerSettings={{
                        barcodeTypes: ["qr", "ean13", "ean8", "upc_e", "codabar", "code39", "code93", "itf14", "pdf417", "aztec", "datamatrix"],
                    }}
                />

                {/* Overlay Elements (Siblings to CameraView) */}
                <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
                    <View style={styles.header}>
                        <TouchableOpacity style={styles.closeButton} onPress={() => closeScanner()}>
                            <Ionicons name="close" size={28} color="#fff" />
                        </TouchableOpacity>
                        <Text style={styles.title}>{'scanCode'}</Text>
                    </View>
                    <View style={styles.overlayContainer}>
                        <View style={styles.scanFrame} />
                        <Text style={styles.instructions}>{'alignCode'}</Text>
                    </View>
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'center',
        backgroundColor: 'black',
    },
    camera: {
        flex: 1,
    },
    header: {
        position: 'absolute',
        top: 50,
        left: 0,
        right: 0,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 20,
        zIndex: 10,
    },
    closeButton: {
        position: 'absolute',
        left: 20,
        padding: 10,
        backgroundColor: 'rgba(0,0,0,0.5)',
        borderRadius: 20,
    },
    title: {
        color: 'white',
        fontSize: 18,
        fontWeight: '600',
    },
    overlayContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    scanFrame: {
        width: 250,
        height: 250,
        borderWidth: 2,
        borderColor: '#00FF00', // Green frame
        backgroundColor: 'transparent',
    },
    instructions: {
        color: 'white',
        marginTop: 20,
        textAlign: 'center',
        fontSize: 16,
        backgroundColor: 'rgba(0,0,0,0.5)',
        padding: 10,
        borderRadius: 8,
    },
});
