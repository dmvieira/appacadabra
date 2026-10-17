#!/usr/bin/env python3
"""Insere a spell fixture no appacadabra.db (schema real do app) e consolida o WAL.

Uso: patch_appdb.py <db> <appId> <name> <code_file> <storage_json>
  storage_json: objeto {key: value} com strings JSON (como app_storage TEXT).
"""
import json
import sqlite3
import sys
import time

db, app_id, name, code_file, storage_json = (
    sys.argv[1],
    int(sys.argv[2]),
    sys.argv[3],
    sys.argv[4],
    sys.argv[5],
)
code = open(code_file, encoding="utf-8").read()
storage = json.loads(storage_json)
now = int(time.time() * 1000)

con = sqlite3.connect(db)
cur = con.cursor()

cols = {r[1] for r in cur.execute("PRAGMA table_info(generated_apps)")}
values = {
    "id": app_id,
    "name": name,
    "code": code,
    "currentVersion": 1,
    "iconPath": "",
    "lastUpdated": now,
    "createdAt": now,
    "consoleLogs": "",
    "totalSpendUsd": 0,
    "jobId": "",
    "requiresBiometric": 0,
    "shortDescription": "Fixture E2E",
    "sortOrder": 0,
    "source": "local",
    "required_capabilities": '["AI"]',
    "required_mcps": "[]",
    "mcp_pending_fix": None,
}
present = {k: v for k, v in values.items() if k in cols}

cur.execute(f"DELETE FROM generated_apps WHERE id = {app_id}")
placeholders = ", ".join("?" for _ in present)
columns = ", ".join(present.keys())
cur.execute(f"INSERT INTO generated_apps ({columns}) VALUES ({placeholders})", list(present.values()))

cur.execute(f"DELETE FROM app_storage WHERE appId = {app_id}")
for k, v in storage.items():
    cur.execute(
        "INSERT INTO app_storage (appId, key, value) VALUES (?, ?, ?)",
        (app_id, k, v if isinstance(v, str) else json.dumps(v)),
    )

con.commit()
# consolida WAL no arquivo principal para o push de um unico .db
cur.execute("PRAGMA wal_checkpoint(TRUNCATE)")
cur.execute("PRAGMA journal_mode=DELETE")
con.commit()
con.close()
print(f"ok: spell #{app_id} + {len(storage)} reliquias")
