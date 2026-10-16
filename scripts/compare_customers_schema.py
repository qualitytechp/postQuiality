import os
import sqlite3

BACKUP = r"C:\Users\Administrador\AppData\Roaming\qualitytech-pos\backups\flo-backup-2026-09-27T16-55-47-121Z-38b52edc.db"
LIVE = r"C:\Users\Administrador\Documents\postQuiality\FloCafe\flo.db"


def read_table_sql(path: str, table_name: str):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        cur = con.cursor()
        row = cur.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table_name,)).fetchone()
        if row is None:
            return None
        return row[0]
    finally:
        con.close()


def read_table_cols(path: str, table_name: str):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        cur = con.cursor()
        rows = cur.execute(f"PRAGMA table_info({table_name})").fetchall()
        return [r[1] for r in rows]
    finally:
        con.close()


def read_schema_version(path: str):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        cur = con.cursor()
        try:
            schema = cur.execute("SELECT value FROM _flo_meta WHERE key='schema_version'").fetchone()
        except Exception:
            schema = None
        user = cur.execute('PRAGMA user_version').fetchone()
        return schema, user
    finally:
        con.close()


for label, path in [('backup', BACKUP), ('live', LIVE)]:
    print(f'--- {label}: {path}')
    if not os.path.exists(path):
        print('MISSING')
        continue
    schema, user = read_schema_version(path)
    print('schema_version:', schema)
    print('user_version:', user)
    print('customers_sql:', read_table_sql(path, 'customers'))
    print('customers_cols:', read_table_cols(path, 'customers'))
