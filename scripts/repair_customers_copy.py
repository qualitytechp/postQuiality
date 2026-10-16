import os
import sqlite3
import shutil

BACKUP = r"C:\Users\Administrador\AppData\Roaming\qualitytech-pos\backups\flo-backup-2026-09-27T16-55-47-121Z-38b52edc.db"
LIVE = r"C:\Users\Administrador\Documents\postQuiality\FloCafe\flo.db"
WORKING = r"C:\Users\Administrador\Documents\postQuiality\FloCafe\backups\flo-restore-working.db"


def ensure_parent(path: str):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)


def read_backup_customer_sql_and_cols():
    con = sqlite3.connect(f"file:{BACKUP}?mode=ro", uri=True)
    try:
        cur = con.cursor()
        row = cur.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='customers'").fetchone()
        if row is None:
            raise RuntimeError("customers table not found in backup")
        sql = row[0]
        cols = [r[1] for r in cur.execute('PRAGMA table_info(customers)').fetchall()]
        return sql, cols
    finally:
        con.close()


def fix_working_copy():
    ensure_parent(WORKING)
    if os.path.exists(WORKING):
        os.remove(WORKING)
    shutil.copy2(LIVE, WORKING)

    sql, cols = read_backup_customer_sql_and_cols()
    con = sqlite3.connect(WORKING)
    try:
        cur = con.cursor()
        cur.execute('PRAGMA foreign_keys=OFF')
        cur.execute('DROP TABLE IF EXISTS customers_old')
        if cur.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='customers'").fetchone():
            cur.execute('ALTER TABLE customers RENAME TO customers_old')
        cur.execute(sql)
        if cur.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='customers_old'").fetchone():
            insert_cols = ', '.join(cols)
            cur.execute(f'INSERT INTO customers ({insert_cols}) SELECT {insert_cols} FROM customers_old')
            cur.execute('DROP TABLE customers_old')
        con.commit()
        print('customers_sql:', cur.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='customers'").fetchone()[0])
        print('row_count:', cur.execute('SELECT COUNT(*) FROM customers').fetchone()[0])
    finally:
        con.close()


if __name__ == '__main__':
    print('backup:', BACKUP)
    print('live:', LIVE)
    print('working:', WORKING)
    fix_working_copy()
    print('done')
