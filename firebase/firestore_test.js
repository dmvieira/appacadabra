const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

async function test() {
    const ref = db.collection('test').doc('testdoc');

    const cases = [
        { name: "Undefined inside array", data: { result: [undefined] } },
        { name: "Nested array", data: { result: [[1, 2]] } },
        { name: "Empty key", data: { result: { "": 1 } } },
        { name: "Object with function", data: { result: { a: () => { } } } },
        { name: "Undefined value", data: { result: undefined } },
        { name: "NaN value", data: { result: NaN } },
        { name: "Infinity value", data: { result: Infinity } }
    ];

    for (const c of cases) {
        try {
            await ref.set(c.data);
            console.log("SUCCESS:", c.name);
        } catch (e) {
            console.log("FAILED:", c.name, "->", e.message);
        }
    }
}

test().catch(console.error);
