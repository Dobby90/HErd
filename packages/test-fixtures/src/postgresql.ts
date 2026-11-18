export const schemaDdl = `
CREATE SCHEMA stage1;
CREATE TYPE stage1."OrderStatus" AS ENUM ('new', 'shipped');
CREATE SEQUENCE stage1."ExternalNumbers" START WITH 100;
CREATE TABLE stage1."Users" (
  "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ExternalNumber" bigint NOT NULL UNIQUE DEFAULT nextval('stage1."ExternalNumbers"'),
  "Email" text NOT NULL,
  "Profile" jsonb DEFAULT '{}'::jsonb
);
CREATE TABLE stage1."Orders" (
  "TenantId" integer NOT NULL,
  "OrderNumber" bigint GENERATED ALWAYS AS IDENTITY,
  "Status" stage1."OrderStatus" DEFAULT 'new',
  "Tags" text[] DEFAULT ARRAY[]::text[],
  PRIMARY KEY ("TenantId", "OrderNumber")
);
CREATE TABLE stage1."OrderItems" (
  "TenantId" integer NOT NULL,
  "OrderNumber" bigint NOT NULL,
  "Line" integer NOT NULL CHECK ("Line" > 0),
  "Price" numeric(12, 2) NOT NULL DEFAULT 0,
  PRIMARY KEY ("TenantId", "OrderNumber", "Line"),
  FOREIGN KEY ("TenantId", "OrderNumber") REFERENCES stage1."Orders" ("TenantId", "OrderNumber")
);
CREATE UNIQUE INDEX "UsersEmail" ON stage1."Users" (lower("Email"));
`;
