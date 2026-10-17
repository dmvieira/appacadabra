#!/usr/bin/env python3
"""Gera o RKStorage (AsyncStorage v2) com o onboarding ja visto."""
import json
import sqlite3
import sys

out = sys.argv[1]
con = sqlite3.connect(out)
con.execute("DROP TABLE IF EXISTS catalystLocalStorage")
con.execute("CREATE TABLE catalystLocalStorage (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
con.execute("INSERT INTO catalystLocalStorage VALUES ('appacadabra_onboarding_seen','true')")
# Pula o modal de escolha de backup nos testes (backupMode 'none' = ignorado)
con.execute(
    "INSERT INTO catalystLocalStorage VALUES ('appacadabra_backup_prefs', ?)",
    (json.dumps({"backupMode": "none", "localFolderUri": None, "lastBackupAt": None, "lastRestoreAt": None}),),
)
con.execute("PRAGMA user_version = 1")
con.commit()
con.execute("PRAGMA journal_mode=DELETE")
con.close()
print("ok:", out)
