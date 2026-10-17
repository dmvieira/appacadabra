#!/usr/bin/env python3
"""Le o indice enc->app (app_settings.devices.encIndex) e imprime o ultimo enc id."""
import json
import sqlite3
import sys

db = sys.argv[1]
con = sqlite3.connect(db)
row = con.execute("select value from app_settings where key='devices.encIndex'").fetchone()
con.close()
if not row or not row[0]:
    sys.exit(1)
keys = list(json.loads(row[0]).keys())
if not keys:
    sys.exit(1)
print(keys[-1])
