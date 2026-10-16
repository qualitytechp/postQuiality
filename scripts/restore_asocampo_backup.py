import os
import shutil
import sqlite3
from datetime import datetime

LIVE_DB = r"C:\Users\Administrador\Documents\postQuiality\FloCafe\flo.db"
BACKUP_DB = r"C:\Users\Administrador\Documents\Asocampo\flo-backup-2026-09-27T16-55-47-121Z-38b52edc.db"
BACKUP_DIR = r"C:\Users\Administrador\Documents\postQuiality\FloCafe\backups"

os.makedirs(BACKUP_DIR, exist_ok=True)

if not os.path.exists(BACKUP_DB):
    raise FileNotFoundError(f"Backup DB not found: {BACKUP_DB}")

if os.path.exists(LIVE_DB):
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    live_backup = os.path.join(BACKUP_DIR, f"flo-live-pre-restore-{timestamp}.db")
    shutil.copy2(LIVE_DB, live_backup)
    print(f"Saved current live DB before restore to: {live_backup}")
else:
    print("No existing live DB found. Proceeding to create one from backup.")

shutil.copy2(BACKUP_DB, LIVE_DB)
print(f"Restored backup to: {LIVE_DB}")

con = sqlite3.connect(LIVE_DB)
cur = con.cursor()
print("schema_version:", cur.execute("PRAGMA schema_version").fetchone()[0])
print("user_version:", cur.execute("PRAGMA user_version").fetchone()[0])
for table in ["customers", "orders", "order_items", "bills", "purchases", "purchase_items", "purchase_payments"]:
    row = cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
    if row:
        count = cur.execute(f"SELECT COUNT(*) FROM \"{table}\"").fetchone()[0]
        print(f"{table}: {count} rows")
    else:
        print(f"{table}: MISSING")
con.close()
