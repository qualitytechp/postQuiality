import os
import sqlite3

BACKUP = r"C:\Users\Administrador\AppData\Roaming\qualitytech-pos\backups\flo-backup-2026-09-27T16-55-47-121Z-38b52edc.db"
LIVE = r"C:\Users\Administrador\Documents\postQuiality\FloCafe\flo.db"
TABLES = [
    "orders",
    "order_items",
    "bills",
    "purchases",
    "purchase_items",
    "purchase_payments",
]

for table in TABLES:
    print(f"--- {table} ---")
    for label, path in [("backup", BACKUP), ("live", LIVE)]:
        if not os.path.exists(path):
            print(label, "MISSING")
            continue
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            cur = con.cursor()
            exists = cur.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
            if not exists:
                print(label, "TABLE MISSING")
                continue
            count = cur.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            print(label, "COUNT:", count)
            sample = cur.execute(f"SELECT id FROM {table} ORDER BY id LIMIT 10").fetchall()
            print(label, "FIRST_IDS:", [x[0] for x in sample])
        finally:
            con.close()
