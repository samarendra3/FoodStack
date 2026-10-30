-- Runs once when the local volume is first created: a separate database for automated tests.
SELECT 'CREATE DATABASE foodstack_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'foodstack_test')\gexec
