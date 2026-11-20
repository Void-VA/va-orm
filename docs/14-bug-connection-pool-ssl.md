# Bug Report — Connection Pool: slot leak & dropped connection options

**Versi terdampak:** `@v-va/orm` 0.1.2 (dan sebelumnya, sejak `core/connection.pool.ts` ada)
**Ditemukan:** 2026-11-18, di produksi `sim-va` (Vercel + Neon Postgres, DSN `-pooler`)
**Tingkat:** kritis — produksi mati total setelah beberapa error pertama

---

## Ringkasan

Dua bug di `ConnectionPool` membuat aplikasi serverless gagal total, dan
kegagalannya menyamar sebagai masalah yang berbeda-beda:

| Gejala di produksi | Penyebab sebenarnya |
|---|---|
| `Connection acquisition timeout` terus-menerus (padahal DB sehat) | Bug #1 — slot pool bocor tiap query gagal |
| `28000 connection is insecure (try using sslmode=require)` walau `ssl` sudah diset | Bug #2 — opsi `ssl` dibuang, driver selalu `ssl: false` |
| Error prepared statement / `prepared statement already exists` di Neon pooler | Bug #3 — deteksi PgBouncer tidak mengenal host `-pooler.neon.tech` |

Ketiganya muncul berurutan: query pertama gagal karena SSL (#2), lalu slot
yang dipakai query gagal itu hilang (#1), sehingga request berikutnya bukan
lagi menampilkan error asli melainkan `Connection acquisition timeout`.

---

## Bug #1 — Slot pool bocor saat query gagal

`packages/client/src/core/connection.pool.ts`, `query()` dan `execute()`:

```ts
for (let attempt = 0; attempt < maxAttempts; attempt++) {
  const driver = await this.acquire();   // inUseCount++
  try {
    const result = await driver.query(sql, params);
    await this.release(driver);          // inUseCount--
    return result;
  } catch (error) {
    lastError = error;
    this.stats.totalErrors++;
    await driver.close().catch(() => {}); // ❌ inUseCount tidak dikurangi
  }
}
```

`acquire()` menaikkan `inUseCount`, tapi jalur error hanya menutup driver
tanpa pernah memanggil `release()`. Setiap query gagal membakar satu slot
secara permanen.

Akibatnya:

1. `max` (default 20; `sim-va` production memakai 5) query gagal → pool penuh.
2. `acquire()` berikutnya masuk `waitingQueue` dan ditolak setelah
   `connectionTimeoutMs` dengan `Connection acquisition timeout`.
3. Instance lambda tetap hidup, jadi error ini bertahan sampai cold start
   berikutnya — terlihat seperti "DB mati" padahal koneksi DB normal.

### Perbaikan

Tambah `discard(driver)` yang menutup driver **dan** mengembalikan slot,
termasuk menyerahkan slot pengganti ke waiter yang sedang antre:

```ts
private async discard(driver: DatabaseDriver): Promise<void> {
  this.inUseCount = Math.max(0, this.inUseCount - 1);
  await driver.close().catch(() => {});

  const waiting = this.waitingQueue.shift();
  if (!waiting) return;
  if (waiting.timeout) clearTimeout(waiting.timeout);

  // Slot bebas: buat koneksi baru untuk waiter, jangan serahkan driver mati.
  this.inUseCount++;
  try {
    const conn = await this.createConnection();
    conn.lastUsed = Date.now();
    conn.useCount = 1;
    waiting.resolve(conn.driver);
  } catch (error) {
    this.inUseCount--;
    waiting.reject(error as Error);
  }
}
```

Dan `query()` / `execute()` memakai `await this.discard(driver)` di cabang
`catch`.

---

## Bug #2 — `ssl` dan `disablePreparedStatements` hilang di tengah jalan

`ConnectionPool` menerima seluruh `ConnectionConfig`, tetapi
`createConnection()` hanya meneruskan tiga field:

```ts
driver = new PostgresDriver(this.dsn, {
  max: 1,
  connectionTimeoutMs: this.config.connectionTimeoutMs,
  applicationName: this.config.applicationName,
  // ❌ ssl, idleTimeoutMs, disablePreparedStatements tidak ikut
});
```

Sementara driver melakukan:

```ts
ssl: this.options.ssl || false,
```

Karena `options.ssl` selalu `undefined` (tidak pernah dikirim), hasilnya
**selalu `ssl: false`**. User sudah set `connection: { ssl: {...} }` atau
`DB_SSL=true`, tapi tetap konek tanpa TLS.

Neon menolak koneksi non-TLS dengan:

```
error: connection is insecure (try using `sslmode=require`)
code: '28000'
```

Yang membuat ini mahal: tidak ada error konfigurasi, tidak ada warning —
opsinya dibuang diam-diam, dan pesan errornya menunjuk ke DSN (bukan ke ORM).

### Perbaikan

1. Simpan `ssl` di config pool:
   ```ts
   this.config = { ..., ssl: options.ssl, ... }
   ```
2. Teruskan ke driver saat membuat koneksi:
   ```ts
   driver = new PostgresDriver(this.dsn, {
     max: 1,
     idleTimeoutMs: this.config.idleTimeoutMs,
     connectionTimeoutMs: this.config.connectionTimeoutMs,
     applicationName: this.config.applicationName,
     disablePreparedStatements: this.config.disablePreparedStatements,
     ssl: this.config.ssl,
   });
   ```
   (MySQL sama: `ssl` ikut diteruskan.)
3. Driver tidak lagi memaksa `false` saat `ssl` tidak diset:
   ```ts
   ...(this.options.ssl ? { ssl: this.options.ssl } : {}),
   ```
   Dengan begitu `sslmode` di DSN tetap dihormati `pg`.

---

## Bug #3 — Deteksi PgBouncer tidak mengenal Neon pooler

```ts
private detectPgBouncer(): boolean {
  return (
    this.connectionString.includes('pgbouncer') ||
    this.connectionString.includes('supavisor') ||
    this.connectionString.includes('transaction_mode=true')
  );
}
```

Host Neon pooled adalah
`ep-xxx-pooler.c-9.us-east-2.aws.neon.tech` — tidak mengandung salah satu
string di atas. Jadi `pgbouncerMode` tetap `false`, `prepareThreshold: 0`
tidak dipasang, dan prepared statement dipakai di atas PgBouncer transaction
mode. Gejalanya intermiten (`prepared statement "..." already exists`,
`bind message supplies ... parameters`), lalu memicu Bug #1.

### Perbaikan

```ts
this.connectionString.includes('-pooler.') // Neon pooled endpoint
```

---

## Dampak & cara mengenali

Pola yang khas di log:

1. Satu error nyata (SSL, prepared statement, constraint, timeout Neon cold start).
2. Setelah `max` error, semua request jadi `Connection acquisition timeout`.
3. Deploy ulang / instance baru → normal sebentar → mengulang.

Kalau melihat `Connection acquisition timeout`, **jangan** langsung
menyalahkan database: cari error pertama sebelum timeout muncul. Itu
penyebab sebenarnya; timeout-nya cuma efek Bug #1.

Mitigasi sementara di sisi aplikasi (tanpa upgrade ORM):

- `max` pool kecil (1–2) di serverless, `connectionTimeoutMs` 10s
  (Neon autosuspend bisa > 5s saat cold start).
- Paksa `ssl` di DSN: `?sslmode=require`, atau pastikan `connection.ssl`
  diteruskan (butuh versi ORM yang sudah diperbaiki).
- Untuk Neon pooled, set `disablePreparedStatements: true` eksplisit
  (`DB_POOLER_MODE=true` di `sim-va`).

## Regression test yang perlu ditambahkan

Sudah ditambahkan di
[`packages/client/src/__tests__/connection-pool-regression.spec.ts`](../packages/client/src/__tests__/connection-pool-regression.spec.ts):

- [x] `query()` gagal → `getStats().activeCount` kembali ke posisi semula.
- [x] `max` query gagal berurutan → query berikutnya tetap jalan (tidak
      `Connection acquisition timeout`).
- [x] `query()` gagal saat ada waiter → slot bebas diserahkan sebagai koneksi
      baru, waiter tidak menerima driver yang sudah ditutup.
- [x] `connection.ssl` sampai ke `PostgresDriver` → `pg.Pool.options.ssl` (spy
      pada opsi driver), dan `ssl` tidak dipaksa `false` saat tidak diset.
- [x] DSN `...-pooler...neon.tech` → `pgbouncerMode === true`
      (`prepareThreshold: 0`).
- [x] `disablePreparedStatements: true` → `prepareThreshold: 0`.

## Status perbaikan

| Bug | Status | Lokasi |
|---|---|---|
| #1 slot bocor | fixed | `core/connection.pool.ts` — `discard()` dipakai di `query()`/`execute()` |
| #2 opsi koneksi dibuang | fixed | `core/connection.pool.ts` `createConnection()` + `drivers/postgres`, `drivers/mysql` |
| #3 deteksi Neon pooler | fixed | `drivers/postgres/postgres.driver.ts` — `detectPgBouncer()` |

