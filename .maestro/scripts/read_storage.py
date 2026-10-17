#!/usr/bin/env python3
"""Imprime o valor de app_storage(appId,key). Uso: read_storage.py <db> <appId> <key>"""
import sqlite3
import sys

db, app_id, key = sys.argv[1], int(sys.argv[2]), sys.argv[3]
con = sqlite3.connect(db)
row = con.execute("select value from app_storage where appId=? and key=?", (app_id, key)).fetchone()
con.close()
print(row[0] if row else "")
