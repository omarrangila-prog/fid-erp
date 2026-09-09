# Certificates

`supabase-prod-ca-2021.crt` is Supabase's public root certificate, downloaded
from `https://supabase-downloads.s3.amazonaws.com/prod/ssl/prod-ca-2021.crt`
and also offered in the dashboard under **Database → SSL Configuration**.

Supabase's connection poolers present certificates signed by this CA rather
than by a public root, so Node will not trust them without it. Point
`DATABASE_SSL_CA` at this file and the chain verifies properly — the
alternative, `sslmode=no-verify`, encrypts the connection but would accept any
certificate at all.

A root certificate is public information. There is no secret here.

Valid until 26 April 2031.
