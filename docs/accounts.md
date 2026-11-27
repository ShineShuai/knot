# The account chain

`src/crypto/chain.js`. Not used by rooms yet (a later step wires it in); this describes the
formats and the rules it checks. The design behind it is in the accounts design document.

An account has a **root key**; the account id is its hash (`peerIdOf`). A **statement** says
"from now on the account key `t` speaks for the account". Each statement is signed by the key
before it (the root key for the first), so the statements form a chain from the root key.

## Statement (canonical binary)

`r` root key (32) · `n` (u16, from 1) · `prev` (32: the hash of statement n-1, or of `r` for
n=1) · `t` new account key (32; all zeros in an **end** statement: nobody speaks afterwards) ·
`ms` (u64, the signer's stamp) · count (u8, at most 16) · `keep` entries (16 bytes each, sorted,
unique: the first 16 bytes of SHA-256 of a device key) · `sig` (64, by the previous key over
`"knot/stmt1"` and everything before `sig`). The statement's hash is SHA-256 of all of it.
About 171 bytes plus 16 per kept device. There is no maximum length of a chain in the protocol.

## Certificates

Generation 0 is as before (`delegation.js`): signed by the root key. Generation k >= 1:
`{ r, d, n, ms, g: { k, h }, sig }`, signed by the key of statement k over `"knot/device2"`,
`r`, `d`, `k`, `h`, the name (length-prefixed) and `ms`; `h` is the hash of statement k. A
certificate is valid under a chain if `h` is the hash of that statement in the chain and the
signature is by that statement's key.

## Which devices stay valid

A certificate of generation k stays valid while **every later statement keeps the device** (its
16-byte hash is in `keep`). The first later statement that does not keep it, or an `end`
statement, retires it: `retiredBy` returns that statement and its `ms`. What a retired device
wrote with a stamp below `ms` still counts; later does not (the room applies this, as for an
unlink). Generation 0 certificates are retired the same way, and the root key's own signatures
count only below the stamp of statement 1 (`rootRetiredAt`).

## Cost

Every statement is checked once: a hash that was verified is remembered (`ChainCache`), and a
peer may make us check at most 64 new statements a minute (`VerifyBudget`); beyond that
`verifyChain` answers `pending` and the work continues later. A made-up chain burns only its
own peer's budget. Two statements on one `prev` are a fork (`isFork`); a room keeps the first it
saw and says so.
