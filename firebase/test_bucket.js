const { initializeApp } = require('firebase-admin/app');
const { getStorage } = require('firebase-admin/storage');

initializeApp();

async function checkBucket(name) {
    try {
        const bucket = getStorage().bucket(name);
        const [exists] = await bucket.exists();
        console.log(`Bucket ${name} exists: ${exists}`);
        return exists;
    } catch (e) {
        console.log(`Bucket ${name} check failed: ${e.message}`);
        return false;
    }
}

async function run() {
    await checkBucket('appacadabra-bee0f.firebasestorage.app');
    await checkBucket('appacadabra-bee0f.appspot.com');
    await checkBucket('videos-appacadabra');
}

run().catch(console.error);
