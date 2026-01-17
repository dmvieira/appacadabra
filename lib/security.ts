import * as Crypto from 'expo-crypto';

// Secret salt to prevent manual editing of backup files
// Note: In a real production app with high stakes, this should be more protected or involve a server.
const INTEGRITY_SALT = 'appacadabra-mana-secure-salt-v1-9a8b7c6d5e4f';

/**
 * Generates a SHA-256 signature for the given string data.
 */
export async function signData(data: string): Promise<string> {
    try {
        const signature = await Crypto.digestStringAsync(
            Crypto.CryptoDigestAlgorithm.SHA256,
            data + INTEGRITY_SALT
        );
        return signature;
    } catch (error) {
        console.error('Error signing data:', error);
        return '';
    }
}

/**
 * Verifies if the data matches the provided signature.
 */
export async function verifyData(data: string, signature: string): Promise<boolean> {
    if (!data || !signature) return false;
    const freshSignature = await signData(data);
    return freshSignature === signature;
}
