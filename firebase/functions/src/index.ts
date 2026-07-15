/**
 * Firebase Functions for Appacadabra (Phase 4: BYOK)
 * Surviving surface: spell publishing + learned spells. AI pipeline now lives client-side
 * (see lib/api/) and mana economy is gone — every callable here only touches Firestore + Storage.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { getAuth } from "firebase-admin/auth";

import * as zlib from "zlib";

import { sanitizeSpellHtml, generateSlug } from "./utils";

initializeApp();
const db = getFirestore();

const REGION = "southamerica-east1";

// Reject anonymous sessions for store actions — anonymous users can read public spells
// but only Google-signed users can mutate the store or own learned_spells.
function requireGoogleAuth(request: { auth?: { uid: string; token: any } | undefined }, msg: string): string {
    if (!request.auth) throw new HttpsError("unauthenticated", msg);
    const provider = (request.auth.token as any)?.firebase?.sign_in_provider;
    if (provider === "anonymous") throw new HttpsError("unauthenticated", msg);
    return request.auth.uid;
}

// ============= SPELL STORE =============

const PUBLISH_SPELL_HOURLY_LIMIT = 10;
const PUBLISH_SPELL_MAX_HTML_BYTES = 512000;

interface PublishSpellInput {
    name: string;
    description?: string;
    htmlBase64: string;
    version: number;
    previewImageBase64?: string;
    iconBase64?: string;
    visibility: "public" | "unlisted";
    forkOfSpellId?: string;
    locale?: string;
    existingSpellId?: string;
}

async function checkPublishRateLimit(uid: string): Promise<void> {
    const userRef = db.collection("users").doc(uid);
    await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        const data = snap.exists ? snap.data() ?? {} : {};
        const now = Date.now();
        const hourAgo = now - 60 * 60 * 1000;
        const rawTimes: number[] = Array.isArray(data.publishSpellTimes) ? data.publishSpellTimes : [];
        const recent = rawTimes.filter((t) => typeof t === "number" && t > hourAgo);
        if (recent.length >= PUBLISH_SPELL_HOURLY_LIMIT) {
            throw new HttpsError("resource-exhausted",
                `Publish rate limit reached (${PUBLISH_SPELL_HOURLY_LIMIT}/hour). Try again later.`);
        }
        recent.push(now);
        tx.set(userRef, { publishSpellTimes: recent }, { merge: true });
    });
}

async function uploadPublicAsset(storagePath: string, buffer: Buffer, contentType: string): Promise<void> {
    const bucket = getStorage().bucket();
    const file = bucket.file(storagePath);
    await file.save(buffer, { contentType, metadata: { contentType } });
    try {
        await file.makePublic();
    } catch (e) {
        console.warn(`[publishSpell] makePublic failed for ${storagePath}:`, e);
    }
}

export const publishSpell = onCall<PublishSpellInput>(
    { region: REGION, enforceAppCheck: false, memory: "512MiB", timeoutSeconds: 120 },
    async (request) => {
        const uid = requireGoogleAuth(request, "Sign in with Google to publish spells to the Store");

        const { name, description, htmlBase64, version, previewImageBase64, iconBase64,
            visibility, forkOfSpellId, locale, existingSpellId } = request.data;
        if (!name || typeof name !== "string") throw new HttpsError("invalid-argument", "Spell name required");
        if (!htmlBase64 || typeof htmlBase64 !== "string") throw new HttpsError("invalid-argument", "Spell HTML required");
        if (visibility !== "public" && visibility !== "unlisted") {
            throw new HttpsError("invalid-argument", 'visibility must be "public" or "unlisted"');
        }
        if (typeof version !== "number" || version < 1) {
            throw new HttpsError("invalid-argument", "version must be a positive number");
        }
        if (forkOfSpellId !== undefined && typeof forkOfSpellId !== "string") {
            throw new HttpsError("invalid-argument", "forkOfSpellId must be a string");
        }

        await checkPublishRateLimit(uid);

        if (!htmlBase64.startsWith("GZIP:")) {
            throw new HttpsError("invalid-argument", "Spell HTML must be gzip-compressed");
        }
        let html: string;
        try {
            html = zlib.gunzipSync(Buffer.from(htmlBase64.substring(5), "base64")).toString("utf-8");
        } catch {
            throw new HttpsError("invalid-argument", "Failed to decompress spell HTML");
        }
        if (Buffer.byteLength(html, "utf-8") > PUBLISH_SPELL_MAX_HTML_BYTES) {
            throw new HttpsError("invalid-argument", "Spell HTML too large (max 500KB)");
        }

        const { html: sanitizedHtml, violations } = sanitizeSpellHtml(html);
        if (violations.length > 0) {
            throw new HttpsError("invalid-argument", "Spell contains unsafe content: " + violations.join(", "));
        }

        const slug = generateSlug(name);

        let spellRef = db.collection("store_spells").doc();
        let spellId = spellRef.id;
        let isUpdate = false;
        if (existingSpellId && typeof existingSpellId === "string") {
            const existingSnap = await db.collection("store_spells").doc(existingSpellId).get();
            if (existingSnap.exists && existingSnap.data()?.authorUid === uid) {
                spellRef = existingSnap.ref;
                spellId = existingSpellId;
                isUpdate = true;
            }
        }

        const htmlStoragePath = `store_html/${spellId}/spell.html`;
        const uploadedPaths: string[] = [];
        try {
            await uploadPublicAsset(htmlStoragePath, Buffer.from(sanitizedHtml, "utf-8"), "text/html; charset=utf-8");
            uploadedPaths.push(htmlStoragePath);

            let previewImagePath: string | null = null;
            if (previewImageBase64) {
                previewImagePath = `store_previews/${spellId}/preview.png`;
                await uploadPublicAsset(previewImagePath, Buffer.from(previewImageBase64, "base64"), "image/png");
                uploadedPaths.push(previewImagePath);
            }

            let iconPath: string | null = null;
            if (iconBase64) {
                iconPath = `store_icons/${spellId}/icon.png`;
                await uploadPublicAsset(iconPath, Buffer.from(iconBase64, "base64"), "image/png");
                uploadedPaths.push(iconPath);
            }

            const finalDescription = (description ?? "").trim();
            if (!finalDescription) throw new HttpsError("invalid-argument", "Description is required");

            const hintLang = typeof locale === "string" ? locale.split("-")[0].toLowerCase() : undefined;
            const originalLang = hintLang ?? "en";
            const translations: Record<string, { name: string; description: string }> = {
                [originalLang]: { name, description: finalDescription },
            };

            const userRecord = await getAuth().getUser(uid);
            const authorName = userRecord.displayName || null;

            // Walk one level up: variants always store the root of the family tree so the UI
            // can show lineage without traversing the chain at read time.
            let resolvedForkOfSpellId: string | null = null;
            let rootSpellId = spellId;
            if (forkOfSpellId) {
                const parentSnap = await db.collection("store_spells").doc(forkOfSpellId).get();
                if (parentSnap.exists) {
                    resolvedForkOfSpellId = forkOfSpellId;
                    const parentData = parentSnap.data()!;
                    rootSpellId = typeof parentData.rootSpellId === "string" ? parentData.rootSpellId : forkOfSpellId;
                }
            }

            const baseDoc = {
                name, description: finalDescription, originalLang, translations, slug,
                htmlStoragePath, previewImagePath, iconPath, publishedVersion: version,
                forkOfSpellId: resolvedForkOfSpellId, rootSpellId,
                updatedAt: FieldValue.serverTimestamp(), status: "active", visibility,
            };

            const storeUrl = `https://appacadabra.ai/store/${spellId}/${slug}`;
            await db.runTransaction(async (tx) => {
                if (isUpdate) {
                    tx.update(spellRef, baseDoc);
                } else {
                    tx.set(spellRef, {
                        ...baseDoc,
                        authorUid: uid,
                        authorName,
                        learnCount: 0,
                        variantCount: 0,
                        publishedAt: FieldValue.serverTimestamp(),
                    });
                    if (resolvedForkOfSpellId) {
                        tx.update(db.collection("store_spells").doc(resolvedForkOfSpellId),
                            { variantCount: FieldValue.increment(1) });
                    }
                }
            });

            return { spellId, slug, storeUrl };
        } catch (e) {
            if (uploadedPaths.length > 0) {
                const bucket = getStorage().bucket();
                await Promise.allSettled(uploadedPaths.map((p) => bucket.file(p).delete()));
            }
            throw e;
        }
    },
);

export const unpublishSpell = onCall<{ spellId: string }>(
    { region: REGION, enforceAppCheck: false },
    async (request) => {
        const uid = requireGoogleAuth(request, "Anonymous users cannot unpublish spells");
        const { spellId } = request.data;
        if (!spellId || typeof spellId !== "string") {
            throw new HttpsError("invalid-argument", "spellId required");
        }

        const spellRef = db.collection("store_spells").doc(spellId);
        const snap = await spellRef.get();
        if (!snap.exists) throw new HttpsError("not-found", "Spell not found");
        const data = snap.data()!;
        if (data.authorUid !== uid) {
            throw new HttpsError("permission-denied", "You can only unpublish your own spells");
        }

        await spellRef.update({ status: "removed", updatedAt: FieldValue.serverTimestamp() });

        const bucket = getStorage().bucket();
        const pathsToDelete = [data.htmlStoragePath, data.iconPath, data.previewImagePath]
            .filter((p): p is string => typeof p === "string");
        await Promise.allSettled(pathsToDelete.map((p) => bucket.file(p).delete()));

        return { success: true };
    },
);

export const learnSpell = onCall<{ spellId: string }>(
    { region: REGION, timeoutSeconds: 30 },
    async (request) => {
        const uid = requireGoogleAuth(request, "Sign in with Google to learn spells.");
        const { spellId } = request.data;
        if (!spellId || typeof spellId !== "string") {
            throw new HttpsError("invalid-argument", "spellId is required.");
        }

        const learnedRef = db.collection("users").doc(uid).collection("learned_spells").doc(spellId);
        const spellRef = db.collection("store_spells").doc(spellId);

        let alreadyLearned = false;
        await db.runTransaction(async (tx) => {
            const [learnedSnap, spellSnap] = await Promise.all([tx.get(learnedRef), tx.get(spellRef)]);
            if (learnedSnap.exists) { alreadyLearned = true; return; }
            if (!spellSnap.exists || spellSnap.data()?.status !== "active") {
                throw new HttpsError("not-found", "Spell not found or no longer available.");
            }
            tx.set(learnedRef, {
                spellId,
                learnedAt: FieldValue.serverTimestamp(),
                syncedToApp: false,
                localAppId: null,
            });
            tx.update(spellRef, { learnCount: FieldValue.increment(1) });
        });

        return alreadyLearned ? { alreadyLearned: true } : { success: true };
    },
);

export const unlearnSpell = onCall<{ spellId: string }>(
    { region: REGION, timeoutSeconds: 30 },
    async (request) => {
        const uid = requireGoogleAuth(request, "Sign in with Google to unlearn spells.");
        const { spellId } = request.data;
        if (!spellId || typeof spellId !== "string") {
            throw new HttpsError("invalid-argument", "spellId is required.");
        }

        const learnedRef = db.collection("users").doc(uid).collection("learned_spells").doc(spellId);
        const learnedSnap = await learnedRef.get();
        if (!learnedSnap.exists) return { ok: true, alreadyUnlearned: true };
        await learnedRef.delete();
        // Best-effort decrement: the user-facing source of truth (learned_spells doc) is
        // already gone, so failing the counter update is non-fatal.
        await db.collection("store_spells").doc(spellId)
            .update({ learnCount: FieldValue.increment(-1) }).catch(() => {});
        return { ok: true };
    },
);

interface SyncedSpellItem {
    spellId: string;
    slug: string;
    name: string;
    description: string;
    iconPath: string | null;
    authorUid: string;
    authorName: string;
    publishedVersion: number;
    signedHtmlUrl: string;
    originalLang?: string;
    translations?: Record<string, { name: string; description: string }>;
    forkOfSpellId?: string | null;
    rootSpellId?: string;
}

export const syncLearnedSpells = onCall<{ lastSyncedAt?: number; forceSpellId?: string; recoverAll?: boolean } | undefined>(
    { region: REGION, timeoutSeconds: 30 },
    async (request) => {
        const uid = requireGoogleAuth(request, "Sign in with Google to sync learned spells.");
        const forceSpellId = typeof request.data?.forceSpellId === "string" ? request.data.forceSpellId : null;
        const recoverAll = request.data?.recoverAll === true;

        // recoverAll returns every learned spell so the client can re-import any missing
        // locally (covers reinstall and cross-device cases); client filters tombstoned ids.
        const baseQuery = db.collection("users").doc(uid).collection("learned_spells");
        const learnedSnap = recoverAll
            ? await baseQuery.get()
            : await baseQuery.where("syncedToApp", "==", false).get();

        // Invariant: forceSpellId covers reinstall — a learned spell can be returned even if
        // it was previously marked syncedToApp on a different installation.
        const candidateIds = new Set<string>(learnedSnap.docs.map((d) => d.id));
        if (forceSpellId && !candidateIds.has(forceSpellId)) {
            const forcedSnap = await db.collection("users").doc(uid)
                .collection("learned_spells").doc(forceSpellId).get();
            if (forcedSnap.exists) candidateIds.add(forceSpellId);
        }

        if (candidateIds.size === 0) return { spells: [] };

        const bucket = getStorage().bucket();
        const expiresAt = Date.now() + 60 * 60 * 1000;

        const results = await Promise.all(Array.from(candidateIds).map(async (spellId) => {
            try {
                const spellSnap = await db.collection("store_spells").doc(spellId).get();
                if (!spellSnap.exists) return null;
                const spell = spellSnap.data()!;
                if (spell.status !== "active") return null;
                if (!spell.htmlStoragePath) return null;

                const [signedHtmlUrl] = await bucket.file(spell.htmlStoragePath)
                    .getSignedUrl({ action: "read", expires: expiresAt });

                const item: SyncedSpellItem = {
                    spellId,
                    slug: spell.slug ?? "",
                    name: spell.name ?? "Spell",
                    description: spell.description ?? "",
                    iconPath: spell.iconPath ?? null,
                    authorUid: typeof spell.authorUid === "string" ? spell.authorUid : "",
                    authorName: spell.authorName ?? "Anonymous",
                    publishedVersion: typeof spell.publishedVersion === "number" ? spell.publishedVersion : 1,
                    signedHtmlUrl,
                    originalLang: typeof spell.originalLang === "string" ? spell.originalLang : "en",
                    translations: (spell.translations && typeof spell.translations === "object")
                        ? spell.translations as Record<string, { name: string; description: string }>
                        : {},
                    forkOfSpellId: typeof spell.forkOfSpellId === "string" ? spell.forkOfSpellId : null,
                    rootSpellId: typeof spell.rootSpellId === "string" ? spell.rootSpellId : spellId,
                };
                return item;
            } catch (e) {
                console.warn(`[syncLearnedSpells] Failed to prepare spell ${spellId}:`, e);
                return null;
            }
        }));

        return { spells: results.filter((s): s is SyncedSpellItem => s !== null) };
    },
);
