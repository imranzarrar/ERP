-- Scrub a COPY of the production database so it is safe to use as the 2.0 demo / local rehearsal database.
-- Run ONLY against the demo database (deploy/clone-prod-to-demo.sh does, after refusing any other database name).
-- Business data (names, documents, amounts) is kept on purpose: the point of the copy is to rehearse upgrades and reconcile real figures.
-- Everything that could ACT on the outside world, or log someone in, is removed:
--   * ZATCA keys / CSIDs / certificates  -> deleted, ZATCA switched off (a demo must never be able to report real invoices)
--   * sessions, reset tokens, onboarding tokens -> deleted
--   * every user password -> one known demo password (hash passed in as :pwhash)
--   * emails and phone numbers -> removed or replaced by an undeliverable demo address
-- Variables: :pwhash (bcrypt hash of the demo password)
\set ON_ERROR_STOP on
BEGIN;

-- ZATCA: identities and keys never travel.
UPDATE companies SET zatca_enabled = false;
DELETE FROM zatca_environment_configs;

-- Logins.
TRUNCATE user_sessions;
DELETE FROM password_reset_tokens;
UPDATE users SET password = :'pwhash', must_change_password = false;

-- Contact details: emails become an undeliverable demo address, phones are emptied (NULL where the column allows it, '' where it is NOT NULL).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('users','email'),('companies','email'),('customers','email'),('vendors','email'),('employees','email'),('investors','email'),
      ('users','phone'),('companies','phone'),('branches','phone'),('customers','phone'),('vendors','phone'),('employees','phone'),('investors','phone')
    ) AS t(tbl, col)
  LOOP
    IF r.col = 'email' THEN
      EXECUTE format('UPDATE %I SET %I = %L || left(id::text, 8) || %L WHERE %I IS NOT NULL AND %I <> %L',
                     r.tbl, r.col, 'contact-', '@demo.invalid', r.col, r.col, '');
    ELSIF (SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=r.tbl AND column_name=r.col) = 'YES' THEN
      EXECUTE format('UPDATE %I SET %I = NULL', r.tbl, r.col);
    ELSE
      EXECUTE format('UPDATE %I SET %I = %L', r.tbl, r.col, '');
    END IF;
  END LOOP;
END $$;

-- Sign-up requests carry real contact people and confirmation tokens: drop them.
DELETE FROM company_onboarding_requests;

-- Where a person connected from.
UPDATE audit_logs SET ip_address = NULL;

COMMIT;

-- Proof, printed to the operator (all must read 0).
SELECT 'zatca_environment_configs rows' AS check_name, count(*) AS must_be_zero FROM zatca_environment_configs
UNION ALL SELECT 'companies with ZATCA enabled', count(*) FROM companies WHERE zatca_enabled
UNION ALL SELECT 'live sessions', count(*) FROM user_sessions
UNION ALL SELECT 'reset tokens', count(*) FROM password_reset_tokens
UNION ALL SELECT 'onboarding requests', count(*) FROM company_onboarding_requests
UNION ALL SELECT 'customers/vendors with a real-looking email', count(*) FROM (SELECT 1 FROM customers WHERE email IS NOT NULL AND email <> '' AND email NOT LIKE '%@demo.invalid' UNION ALL SELECT 1 FROM vendors WHERE email IS NOT NULL AND email <> '' AND email NOT LIKE '%@demo.invalid') x
UNION ALL SELECT 'users with a real-looking email', count(*) FROM users WHERE email IS NOT NULL AND email <> '' AND email NOT LIKE '%@demo.invalid';
