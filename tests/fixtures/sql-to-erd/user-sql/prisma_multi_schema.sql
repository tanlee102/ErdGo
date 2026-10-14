-- Prisma-like SQL: quoted PascalCase tables, join tables, schema-qualified targets.
CREATE SCHEMA IF NOT EXISTS "app";

CREATE TABLE "app"."Tenant" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "app"."User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "app"."Project" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "ownerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "app"."_ProjectToUser" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_ProjectToUser_AB_pkey" PRIMARY KEY ("A", "B")
);

CREATE UNIQUE INDEX "Tenant_slug_key" ON "app"."Tenant"("slug");
CREATE UNIQUE INDEX "User_tenantId_email_key" ON "app"."User"("tenantId", "email");
CREATE UNIQUE INDEX "Project_tenantId_key_key" ON "app"."Project"("tenantId", "key");
CREATE INDEX "_ProjectToUser_B_index" ON "app"."_ProjectToUser"("B");

ALTER TABLE "app"."User"
    ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "app"."Tenant"("id") ON DELETE CASCADE;
ALTER TABLE "app"."Project"
    ADD CONSTRAINT "Project_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "app"."Tenant"("id") ON DELETE CASCADE;
ALTER TABLE "app"."Project"
    ADD CONSTRAINT "Project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "app"."User"("id") ON DELETE SET NULL;
ALTER TABLE "app"."_ProjectToUser"
    ADD CONSTRAINT "_ProjectToUser_A_fkey" FOREIGN KEY ("A") REFERENCES "app"."Project"("id") ON DELETE CASCADE;
ALTER TABLE "app"."_ProjectToUser"
    ADD CONSTRAINT "_ProjectToUser_B_fkey" FOREIGN KEY ("B") REFERENCES "app"."User"("id") ON DELETE CASCADE;
