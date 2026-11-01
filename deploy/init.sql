-- Local docker-compose bootstrap: separate owner (migrations) and app (runtime) roles.
CREATE ROLE vetledger_owner LOGIN PASSWORD 'owner';
CREATE ROLE vetledger_app LOGIN PASSWORD 'app';
CREATE DATABASE vetledger OWNER vetledger_owner;
\c vetledger
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
