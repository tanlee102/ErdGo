/** Verifies real user SQL fixtures produce expected tables, relations, and diagnostics. */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAST } from '@/lib/parse-ast/parseAst.js';
import { sqlToErdSchema } from '@/lib/erdJsonSchema.js';

const fixtureDir = new URL('../../fixtures/sql-to-erd/user-sql/', import.meta.url);

const fixtures = [
    {
        fixture: 'mssql_efcore_identity.sql',
        tables: ['AspNetRoles', 'AspNetUsers', 'AspNetUserRoles', 'AspNetUserClaims'],
        indexes: ['RoleNameIndex', 'EmailIndex', 'UserNameIndex', 'IX_AspNetUserRoles_RoleId', 'IX_AspNetUserClaims_UserId'],
        foreignNames: ['FK_AspNetUserRoles_AspNetUsers_UserId', 'FK_AspNetUserRoles_AspNetRoles_RoleId', 'FK_AspNetUserClaims_AspNetUsers_UserId'],
        relations: [
            'FK_AspNetUserRoles_AspNetUsers_UserId:AspNetUserRoles.UserId->AspNetUsers.Id',
            'FK_AspNetUserRoles_AspNetRoles_RoleId:AspNetUserRoles.RoleId->AspNetRoles.Id',
            'FK_AspNetUserClaims_AspNetUsers_UserId:AspNetUserClaims.UserId->AspNetUsers.Id',
        ],
        columns: [
            { table: 'AspNetRoles', column: 'Id', constraints: ['PK'], flags: ['pk'] },
            { table: 'AspNetRoles', column: 'NormalizedName', constraints: ['PUQ'], extras: ['PARTIAL UNIQUE INDEX RoleNameIndex WHERE [NormalizedName] IS NOT NULL'] },
            { table: 'AspNetUsers', column: 'NormalizedEmail', constraints: ['IDX'] },
            { table: 'AspNetUsers', column: 'NormalizedUserName', constraints: ['PUQ'], extras: ['PARTIAL UNIQUE INDEX UserNameIndex WHERE [NormalizedUserName] IS NOT NULL'] },
            { table: 'AspNetUsers', column: 'EmailConfirmed', constraints: ['NN'] },
            { table: 'AspNetUserRoles', column: 'UserId', constraints: ['PK'], flags: ['pk', 'fk', 'compositePk'] },
            { table: 'AspNetUserRoles', column: 'RoleId', constraints: ['PK'], flags: ['pk', 'fk', 'compositePk'] },
            { table: 'AspNetUserClaims', column: 'Id', constraints: ['PK'], flags: ['pk', 'autoIncrement'] },
            { table: 'AspNetUserClaims', column: 'UserId', constraints: ['NN', 'IDX'], flags: ['fk'] },
        ],
    },
    {
        fixture: 'mssql_reporting_star.sql',
        tables: ['DimCustomer', 'DimProduct', 'FactSales'],
        indexes: ['IX_FactSales_CustomerDate', 'IX_FactSales_ProductDate'],
        foreignNames: ['FK_FactSales_DimCustomer', 'FK_FactSales_DimProduct'],
        relations: [
            'FK_FactSales_DimCustomer:FactSales.CustomerKey->DimCustomer.CustomerKey',
            'FK_FactSales_DimProduct:FactSales.ProductKey->DimProduct.ProductKey',
        ],
        columns: [
            { table: 'DimCustomer', column: 'CustomerKey', constraints: ['PK'], flags: ['pk', 'autoIncrement'] },
            { table: 'DimCustomer', column: 'CustomerCode', constraints: ['UQ', 'NN'] },
            { table: 'DimProduct', column: 'Sku', constraints: ['UQ', 'NN'] },
            { table: 'FactSales', column: 'SalesKey', constraints: ['PK'], extras: ['DEFAULT (NEXT VALUE FOR'], flags: ['pk'] },
            { table: 'FactSales', column: 'CustomerKey', constraints: ['NN', 'IDX'], flags: ['fk', 'compositeIdx'] },
            { table: 'FactSales', column: 'ProductKey', constraints: ['NN', 'IDX'], flags: ['fk', 'compositeIdx'] },
            { table: 'FactSales', column: 'NetAmount', type: 'COMPUTED', extras: ['GrossAmount', 'DiscountAmount', 'PERSISTED'] },
        ],
    },
    {
        fixture: 'mysqldump_ecommerce.sql',
        tables: ['customers_dump', 'orders_dump', 'order_lines_dump'],
        types: ['state_enum', 'flags_set', 'status_enum'],
        indexes: ['idx_customers_dump_state_created', 'idx_orders_dump_customer_status', 'idx_order_lines_dump_sku_qty'],
        foreignNames: ['fk_orders_dump_customer', 'fk_lines_dump_order'],
        relations: [
            'fk_orders_dump_customer:orders_dump.customer_id->customers_dump.id',
            'fk_lines_dump_order:order_lines_dump.order_id->orders_dump.id',
        ],
        columns: [
            { table: 'customers_dump', column: 'id', constraints: ['PK'], flags: ['pk', 'autoIncrement'] },
            { table: 'customers_dump', column: 'email', constraints: ['UQ', 'NN'] },
            { table: 'customers_dump', column: 'state', type: 'state_enum', constraints: ['NN', 'IDX'], flags: ['compositeIdx'] },
            { table: 'customers_dump', column: 'flags', type: 'flags_set', extras: ["DEFAULT 'newsletter'"] },
            { table: 'orders_dump', column: 'customer_id', constraints: ['NN', 'IDX'], flags: ['fk', 'compositeIdx'] },
            { table: 'orders_dump', column: 'status', type: 'status_enum', constraints: ['NN', 'IDX'], flags: ['compositeIdx'] },
            { table: 'order_lines_dump', column: 'order_id', constraints: ['PK'], flags: ['pk', 'fk', 'compositePk'] },
            { table: 'order_lines_dump', column: 'line_cents', extras: ['GENERATED ALWAYS AS', 'qty * unit_cents', 'STORED'] },
        ],
    },
    {
        fixture: 'mysql_laravel_shop.sql',
        tables: ['migrations', 'users', 'products', 'carts', 'cart_items'],
        types: ['role_enum', 'status_enum', 'state_enum'],
        indexes: ['products_status_created_index', 'carts_user_state_index', 'cart_items_product_id_foreign'],
        foreignNames: ['products_seller_id_foreign', 'carts_user_id_foreign', 'cart_items_cart_id_foreign', 'cart_items_product_id_foreign'],
        relations: [
            'products_seller_id_foreign:products.seller_id->users.id',
            'carts_user_id_foreign:carts.user_id->users.id',
            'cart_items_cart_id_foreign:cart_items.cart_id->carts.id',
            'cart_items_product_id_foreign:cart_items.product_id->products.id',
        ],
        columns: [
            { table: 'migrations', column: 'id', constraints: ['PK'], flags: ['pk', 'autoIncrement'] },
            { table: 'users', column: 'email', constraints: ['UQ', 'NN'] },
            { table: 'users', column: 'role', type: 'role_enum', constraints: ['NN'], extras: ["DEFAULT 'customer'"] },
            { table: 'products', column: 'seller_id', constraints: ['NN', 'UQ'], flags: ['fk', 'compositeUq'] },
            { table: 'products', column: 'status', type: 'status_enum', constraints: ['NN', 'IDX'], flags: ['compositeIdx'] },
            { table: 'carts', column: 'user_id', constraints: ['NN', 'IDX'], flags: ['fk', 'compositeIdx'] },
            { table: 'cart_items', column: 'cart_id', constraints: ['PK'], flags: ['pk', 'fk', 'compositePk'] },
            { table: 'cart_items', column: 'product_id', constraints: ['PK'], flags: ['pk', 'fk', 'compositePk'] },
        ],
    },
    {
        fixture: 'mysql_wordpress_plugin.sql',
        tables: ['wp_users', 'wp_posts', 'wp_postmeta', 'wp_acme_events'],
        types: ['event_type_enum'],
        indexes: ['user_login_key', 'user_email', 'post_name', 'type_status_date', 'post_author', 'post_id', 'meta_key', 'acme_user_post_event', 'acme_created_at'],
        relations: [],
        columns: [
            { table: 'wp_users', column: 'ID', constraints: ['PK'], flags: ['pk', 'autoIncrement'] },
            { table: 'wp_users', column: 'user_login', constraints: ['NN', 'IDX'], extras: ["DEFAULT ''"] },
            { table: 'wp_posts', column: 'post_author', constraints: ['NN', 'IDX'], extras: ['DEFAULT 0'] },
            { table: 'wp_posts', column: 'post_status', constraints: ['NN', 'IDX'], extras: ["DEFAULT 'publish'"], flags: ['compositeIdx'] },
            { table: 'wp_postmeta', column: 'post_id', constraints: ['NN', 'IDX'], extras: ['DEFAULT 0'] },
            { table: 'wp_acme_events', column: 'event_type', type: 'event_type_enum', constraints: ['NN', 'IDX'], extras: ["DEFAULT 'view'"], flags: ['compositeIdx'] },
            { table: 'wp_acme_events', column: 'created_at', constraints: ['NN', 'IDX'], extras: ['DEFAULT CURRENT_TIMESTAMP'] },
        ],
    },
    {
        fixture: 'pg_dump_acl_public.sql',
        tables: ['accounts', 'profiles', 'sessions'],
        types: ['account_state', 'profile_address'],
        indexes: ['profiles_active_email_idx', 'sessions_account_expiry_idx'],
        foreignNames: ['profiles_account_fk', 'sessions_account_fk', 'sessions_profile_fk'],
        relations: [
            'profiles_account_fk:profiles.account_id->accounts.id',
            'sessions_account_fk:sessions.account_id->accounts.id',
            'sessions_profile_fk:sessions.profile_id->profiles.id',
        ],
        columns: [
            { table: 'accounts', column: 'id', constraints: ['PK'], extras: ['DEFAULT gen_random_uuid()'], flags: ['pk'] },
            { table: 'accounts', column: 'tenant_key', constraints: ['UQ', 'NN'] },
            { table: 'accounts', column: 'state', type: 'account_state', constraints: ['NN'], extras: ["DEFAULT 'trial'"] },
            { table: 'profiles', column: 'account_id', constraints: ['NN', 'PUQ'], extras: ['PARTIAL UNIQUE INDEX profiles_active_email_idx WHERE deleted_at IS NULL'], flags: ['fk', 'compositePartialUq'] },
            { table: 'profiles', column: 'email', constraints: ['NN', 'PUQ'], extras: ['PARTIAL UNIQUE INDEX profiles_active_email_idx WHERE deleted_at IS NULL'], flags: ['compositePartialUq'] },
            { table: 'profiles', column: 'billing_address', type: 'profile_address' },
            { table: 'sessions', column: 'profile_id', flags: ['fk'] },
            { table: 'sessions', column: 'expires_at', constraints: ['NN', 'IDX'], flags: ['compositeIdx'] },
        ],
    },
    {
        fixture: 'postgres_django_auth.sql',
        tables: ['django_content_type', 'auth_permission', 'auth_group', 'auth_group_permissions', 'auth_user', 'auth_user_groups', 'auth_user_user_permissions'],
        indexes: ['auth_permission_content_type_idx', 'auth_user_email_idx', 'auth_user_groups_group_idx'],
        foreignNames: [
            'auth_permission_content_type_fk',
            'auth_group_permissions_group_fk',
            'auth_group_permissions_permission_fk',
            'auth_user_groups_user_fk',
            'auth_user_groups_group_fk',
            'auth_user_permissions_user_fk',
            'auth_user_permissions_permission_fk',
        ],
        relations: [
            'auth_permission_content_type_fk:auth_permission.content_type_id->django_content_type.id',
            'auth_group_permissions_group_fk:auth_group_permissions.group_id->auth_group.id',
            'auth_group_permissions_permission_fk:auth_group_permissions.permission_id->auth_permission.id',
            'auth_user_groups_user_fk:auth_user_groups.user_id->auth_user.id',
            'auth_user_groups_group_fk:auth_user_groups.group_id->auth_group.id',
            'auth_user_permissions_user_fk:auth_user_user_permissions.user_id->auth_user.id',
            'auth_user_permissions_permission_fk:auth_user_user_permissions.permission_id->auth_permission.id',
        ],
        columns: [
            { table: 'django_content_type', column: 'app_label', constraints: ['NN', 'UQ'], flags: ['compositeUq'] },
            { table: 'auth_permission', column: 'content_type_id', constraints: ['NN', 'UQ'], flags: ['fk', 'compositeUq'] },
            { table: 'auth_group', column: 'name', constraints: ['UQ', 'NN'] },
            { table: 'auth_group_permissions', column: 'group_id', constraints: ['PK'], flags: ['pk', 'fk', 'compositePk'] },
            { table: 'auth_user', column: 'username', constraints: ['UQ', 'NN'] },
            { table: 'auth_user', column: 'email', constraints: ['NN', 'IDX'] },
            { table: 'auth_user_groups', column: 'group_id', constraints: ['PK'], flags: ['pk', 'fk', 'compositePk'] },
            { table: 'auth_user_user_permissions', column: 'permission_id', constraints: ['PK'], flags: ['pk', 'fk', 'compositePk'] },
        ],
    },
    {
        fixture: 'postgres_hasura_events.sql',
        tables: ['customers', 'orders', 'order_events', 'event_deliveries'],
        types: ['event_status', 'delivery_state'],
        indexes: ['order_events_status_idx', 'order_events_payload_idx', 'event_deliveries_state_idx'],
        foreignNames: ['orders_customer_fk', 'order_events_order_fk', 'event_deliveries_event_fk'],
        relations: [
            'orders_customer_fk:orders.customer_id->customers.id',
            'order_events_order_fk:order_events.order_id->orders.id',
            'event_deliveries_event_fk:event_deliveries.event_id->order_events.id',
        ],
        columns: [
            { table: 'customers', column: 'email', constraints: ['UQ', 'NN'] },
            { table: 'orders', column: 'customer_id', constraints: ['NN'], flags: ['fk'] },
            { table: 'orders', column: 'order_no', constraints: ['UQ', 'NN'] },
            { table: 'order_events', column: 'event_key', extras: ['GENERATED ALWAYS AS', "event_type || ':' || aggregate_id", 'STORED'] },
            { table: 'order_events', column: 'status', type: 'event_status', constraints: ['NN', 'IDX'], extras: ["DEFAULT 'queued'"], flags: ['compositeIdx'] },
            { table: 'order_events', column: 'payload', type: 'JSONB', constraints: ['NN', 'IDX'], extras: ["DEFAULT '{}'"] },
            { table: 'event_deliveries', column: 'event_id', constraints: ['PK'], flags: ['pk', 'fk', 'compositePk'] },
            { table: 'event_deliveries', column: 'state', type: 'delivery_state', constraints: ['NN', 'IDX'], flags: ['compositeIdx'] },
        ],
    },
    {
        fixture: 'prisma_multi_schema.sql',
        tables: ['Tenant', 'User', 'Project', '_ProjectToUser'],
        indexes: ['Tenant_slug_key', 'User_tenantId_email_key', 'Project_tenantId_key_key', '_ProjectToUser_B_index'],
        foreignNames: ['User_tenantId_fkey', 'Project_tenantId_fkey', 'Project_ownerId_fkey', '_ProjectToUser_A_fkey', '_ProjectToUser_B_fkey'],
        relations: [
            'User_tenantId_fkey:User.tenantId->Tenant.id',
            'Project_tenantId_fkey:Project.tenantId->Tenant.id',
            'Project_ownerId_fkey:Project.ownerId->User.id',
            '_ProjectToUser_A_fkey:_ProjectToUser.A->Project.id',
            '_ProjectToUser_B_fkey:_ProjectToUser.B->User.id',
        ],
        columns: [
            { table: 'Tenant', column: 'slug', constraints: ['UQ', 'NN'] },
            { table: 'User', column: 'tenantId', constraints: ['NN', 'UQ'], flags: ['fk', 'compositeUq'] },
            { table: 'Project', column: 'key', constraints: ['NN', 'UQ'], flags: ['compositeUq'] },
            { table: 'Project', column: 'ownerId', flags: ['fk'] },
            { table: '_ProjectToUser', column: 'A', constraints: ['PK'], flags: ['pk', 'fk', 'compositePk'] },
            { table: '_ProjectToUser', column: 'B', constraints: ['PK'], flags: ['pk', 'fk', 'compositePk'] },
        ],
    },
    {
        fixture: 'rails_schema_dump.sql',
        tables: ['schema_migrations', 'ar_internal_metadata', 'users', 'posts', 'comments'],
        indexes: ['index_users_on_email', 'index_posts_on_user_id_and_slug', 'index_comments_on_post_id_and_created_at'],
        foreignNames: ['fk_rails_posts_users', 'fk_rails_comments_posts', 'fk_rails_comments_authors'],
        relations: [
            'fk_rails_posts_users:posts.user_id->users.id',
            'fk_rails_comments_posts:comments.post_id->posts.id',
            'fk_rails_comments_authors:comments.author_id->users.id',
        ],
        columns: [
            { table: 'schema_migrations', column: 'version', constraints: ['PK'], flags: ['pk'] },
            { table: 'users', column: 'email', constraints: ['UQ', 'NN'] },
            { table: 'users', column: 'preferences', type: 'JSONB', constraints: ['NN'], extras: ["DEFAULT '{}'"] },
            { table: 'posts', column: 'user_id', constraints: ['NN', 'UQ'], flags: ['fk', 'compositeUq'] },
            { table: 'posts', column: 'slug', constraints: ['NN', 'UQ'], flags: ['compositeUq'] },
            { table: 'comments', column: 'post_id', constraints: ['NN', 'IDX'], flags: ['fk', 'compositeIdx'] },
            { table: 'comments', column: 'author_id', flags: ['fk'] },
        ],
    },
    {
        fixture: 'sqlserver_ssms_school.sql',
        tables: ['Schools', 'Students', 'Enrollments'],
        indexes: ['IX_Enrollments_Status'],
        foreignNames: ['FK_Students_Schools', 'FK_Enrollments_Students', 'FK_Enrollments_Schools'],
        relations: [
            'FK_Students_Schools:Students.SchoolID->Schools.SchoolID',
            'FK_Enrollments_Students:Enrollments.StudentID->Students.StudentID',
            'FK_Enrollments_Schools:Enrollments.SchoolID->Schools.SchoolID',
        ],
        columns: [
            { table: 'Schools', column: 'SchoolID', type: 'INT', constraints: ['PK'], flags: ['pk', 'autoIncrement'] },
            { table: 'Schools', column: 'Code', constraints: ['UQ', 'NN'] },
            { table: 'Students', column: 'SchoolID', constraints: ['NN', 'UQ'], flags: ['fk', 'compositeUq'] },
            { table: 'Students', column: 'FullName', type: 'COMPUTED', extras: ['FirstName', 'LastName', 'PERSISTED'] },
            { table: 'Enrollments', column: 'StudentID', constraints: ['NN'], flags: ['fk'] },
            { table: 'Enrollments', column: 'Status', constraints: ['NN', 'IDX'], flags: ['compositeIdx'] },
            { table: 'Enrollments', column: 'CreatedAt', constraints: ['NN', 'IDX'], flags: ['compositeIdx'] },
        ],
    },
    {
        fixture: 'sqlite_desktop_export.sql',
        tables: ['customers', 'invoices', 'invoice_lines'],
        indexes: ['index_invoices_on_customer_status', 'index_invoice_lines_on_description'],
        relations: [
            'invoices.customer_id->customers.id',
            'invoice_lines.invoice_id->invoices.id',
        ],
        columns: [
            { table: 'customers', column: 'id', constraints: ['PK'], flags: ['pk', 'autoIncrement'] },
            { table: 'customers', column: 'email', constraints: ['UQ', 'NN'] },
            { table: 'customers', column: 'plan', constraints: ['NN'], extras: ["DEFAULT 'free'", 'customers_plan_check'] },
            { table: 'invoices', column: 'customer_id', constraints: ['NN', 'IDX'], flags: ['fk', 'compositeIdx'] },
            { table: 'invoices', column: 'status', constraints: ['NN', 'IDX'], flags: ['compositeIdx'] },
            { table: 'invoice_lines', column: 'invoice_id', constraints: ['PK'], flags: ['pk', 'fk', 'compositePk'] },
            { table: 'invoice_lines', column: 'amount_cents', constraints: ['NN'], extras: ['CHECK', 'amount_cents >= 0'] },
        ],
    },
    {
        fixture: 'sqlite_datasette_archive.sql',
        tables: ['artists', 'albums', 'tracks', 'playlists', 'playlist_track'],
        indexes: ['idx_albums_artist_year', 'idx_tracks_album_title', 'idx_playlist_track_position'],
        relations: [
            'albums.artist_id->artists.artist_id',
            'tracks.album_id->albums.album_id',
            'playlist_track.playlist_id->playlists.playlist_id',
            'playlist_track.track_id->tracks.track_id',
        ],
        columns: [
            { table: 'artists', column: 'artist_id', constraints: ['PK'], flags: ['pk'] },
            { table: 'artists', column: 'name', constraints: ['UQ', 'NN'] },
            { table: 'artists', column: 'sort_name', extras: ['GENERATED ALWAYS AS', 'lower(name)', 'STORED'] },
            { table: 'albums', column: 'artist_id', constraints: ['NN', 'IDX'], flags: ['fk', 'compositeIdx'] },
            { table: 'tracks', column: 'album_id', constraints: ['NN', 'IDX'], flags: ['fk', 'compositeIdx'] },
            { table: 'tracks', column: 'duration_ms', constraints: ['NN'], extras: ['CHECK', 'duration_ms >= 0'] },
            { table: 'playlist_track', column: 'playlist_id', constraints: ['PK'], flags: ['pk', 'fk', 'compositePk'] },
            { table: 'playlist_track', column: 'track_id', constraints: ['PK'], flags: ['pk', 'fk', 'compositePk'] },
        ],
    },
    {
        fixture: 'sqlite_room_mobile.sql',
        tables: ['room_master_table', 'channels', 'messages', 'message_reactions'],
        indexes: ['index_channels_workspace_id_name', 'index_messages_channel_sent', 'index_reactions_user_emoji'],
        relations: [
            'messages.channel_id->channels.channel_id',
            'message_reactions.message_id->messages.message_id',
        ],
        columns: [
            { table: 'room_master_table', column: 'id', constraints: ['PK'], flags: ['pk'] },
            { table: 'channels', column: 'channel_id', constraints: ['PK'], flags: ['pk'] },
            { table: 'channels', column: 'workspace_id', constraints: ['NN', 'IDX'], flags: ['compositeIdx'] },
            { table: 'messages', column: 'channel_id', constraints: ['NN', 'IDX'], flags: ['fk', 'compositeIdx'] },
            { table: 'messages', column: 'sent_at', constraints: ['NN', 'IDX'], flags: ['compositeIdx'] },
            { table: 'message_reactions', column: 'message_id', constraints: ['PK'], flags: ['pk', 'fk', 'compositePk'] },
            { table: 'message_reactions', column: 'user_id', constraints: ['PK'], flags: ['pk', 'compositePk'] },
            { table: 'message_reactions', column: 'emoji', constraints: ['PK'], flags: ['pk', 'compositePk'] },
        ],
    },
    {
        fixture: 'supabase_auth_storage.sql',
        tables: ['users', 'buckets', 'objects'],
        schemaTables: ['auth.users', 'storage.buckets', 'storage.objects'],
        indexes: ['objects_bucket_name_idx', 'objects_owner_bucket_idx'],
        foreignNames: ['buckets_owner_fk', 'objects_bucket_fk', 'objects_owner_fk'],
        relations: [
            'buckets_owner_fk:storage.buckets.owner->auth.users.id',
            'objects_bucket_fk:storage.objects.bucket_id->storage.buckets.id',
            'objects_owner_fk:storage.objects.owner->auth.users.id',
        ],
        columns: [
            { table: 'users', column: 'email', constraints: ['UQ', 'NN'] },
            { table: 'users', column: 'role', constraints: ['NN'], extras: ["DEFAULT 'authenticated'"] },
            { table: 'buckets', column: 'owner', flags: ['fk'] },
            { table: 'buckets', column: 'public', constraints: ['NN'], extras: ['DEFAULT false'] },
            { table: 'objects', column: 'bucket_id', constraints: ['NN', 'IDX'], flags: ['fk', 'compositeIdx'] },
            { table: 'objects', column: 'owner', constraints: ['IDX'], flags: ['fk', 'compositeIdx'] },
            { table: 'objects', column: 'path_tokens', type: 'TEXT[]', extras: ["DEFAULT '{}'"] },
        ],
    },
    {
        fixture: 'typeorm_mysql_uuid.sql',
        tables: ['tenant', 'user', 'photo', 'typeorm_metadata'],
        types: ['billingState_enum', 'role_enum', 'visibility_enum'],
        indexes: ['IDX_photo_user_sort'],
        foreignNames: ['FK_user_tenant', 'FK_photo_user'],
        relations: [
            'FK_user_tenant:user.tenantId->tenant.id',
            'FK_photo_user:photo.userId->user.id',
        ],
        columns: [
            { table: 'tenant', column: 'slug', constraints: ['UQ', 'NN'] },
            { table: 'tenant', column: 'billingState', type: 'billingState_enum', constraints: ['NN'], extras: ["DEFAULT 'trial'"] },
            { table: 'user', column: 'tenantId', constraints: ['NN', 'UQ'], flags: ['fk', 'compositeUq'] },
            { table: 'user', column: 'role', type: 'role_enum', constraints: ['NN'], extras: ["DEFAULT 'member'"] },
            { table: 'user', column: 'emailKey', extras: ['GENERATED ALWAYS AS', 'lower(email)', 'VIRTUAL'] },
            { table: 'photo', column: 'userId', constraints: ['NN', 'IDX'], flags: ['fk', 'compositeIdx'] },
            { table: 'photo', column: 'sortOrder', constraints: ['NN', 'IDX'], extras: ['DEFAULT 0'], flags: ['compositeIdx'] },
        ],
    },
];

const perturbations = [
    {
        name: 'client banner comments',
        apply: (sql) => `-- pasted from database client\n/* schema export begins */\n${sql}`,
    },
    {
        name: 'CRLF export',
        apply: (sql) => sql.replace(/\n/g, '\r\n'),
    },
    {
        name: 'UTF-8 BOM and padding',
        apply: (sql) => `\uFEFF\n\n${sql}\n\n`,
    },
    {
        name: 'ignored client statements',
        apply: (sql) => `SELECT 1;\n${sql}\nCREATE VIEW ignored_user_fixture_view AS SELECT 1;\nDROP VIEW ignored_user_fixture_view;\n`,
    },
    {
        name: 'SQL Server batch wrapper',
        apply: (sql) => `GO\n${sql}\nGO\n`,
    },
];

const fixtureCases = fixtures.flatMap((fixture) =>
    perturbations.map((perturbation) => ({
        name: `${fixture.fixture} - ${perturbation.name}`,
        fixture,
        perturbation,
    })),
);

function readFixture(fixture) {
    return readFileSync(new URL(fixture, fixtureDir), 'utf8');
}

function stripSchema(name) {
    if (!name) return name;
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1) : name;
}

function astTableNames(parsed) {
    return parsed.ast.tables.map((table) => stripSchema(table.name));
}

function astTypeNames(parsed) {
    return parsed.ast.types.map((type) => stripSchema(type.name));
}

function astIndexNames(parsed) {
    return parsed.ast.indexes.map((index) => index.name).filter(Boolean);
}

function astForeignNames(parsed) {
    return parsed.ast.tables.flatMap((table) => table.constraints || [])
        .filter((constraint) => constraint.kind === 'foreign' && constraint.name)
        .map((constraint) => constraint.name)
        .concat(
            parsed.ast.alters
                .filter((alter) => alter.action === 'add_foreign' && alter.name)
                .map((alter) => alter.name),
        );
}

function relationKeys(schema) {
    return schema.relations.map((relation) => {
        const prefix = relation.fkName ? `${relation.fkName}:` : '';
        return `${prefix}${relation.from.table}.${relation.from.column}->${relation.to.table}.${relation.to.column}`;
    });
}

function splitQualifiedColumnRef(value) {
    const dot = String(value || '').lastIndexOf('.');
    return dot >= 0 ? [value.slice(0, dot), value.slice(dot + 1)] : [value, ''];
}

function tableByName(schema, tableName) {
    const exact = schema.tables.find((table) => table.name === tableName);
    if (exact) return exact;
    const leafMatches = schema.tables.filter((table) => stripSchema(table.name) === tableName);
    return leafMatches.length === 1 ? leafMatches[0] : undefined;
}

function columnByName(schema, tableName, columnName) {
    return tableByName(schema, tableName)?.columns.find((column) => column.name === columnName);
}

function assertRenderable(schema) {
    expect(Array.isArray(schema.enums)).toBe(true);
    expect(Array.isArray(schema.composites)).toBe(true);
    expect(Array.isArray(schema.tables)).toBe(true);
    expect(Array.isArray(schema.relations)).toBe(true);
    expect(Array.isArray(schema._parseErrors)).toBe(true);

    for (const table of schema.tables) {
        expect(table.name).toBeTruthy();
        expect(Array.isArray(table.columns)).toBe(true);
        for (const column of table.columns) {
            expect(column.name).toBeTruthy();
            expect(typeof column.type).toBe('string');
            expect(Array.isArray(column.constraints)).toBe(true);
            expect(Array.isArray(column.extras)).toBe(true);
        }
    }
}

function assertContainsAll(actual, expected = []) {
    for (const value of expected) {
        expect(actual).toContain(value);
    }
}

function assertColumn(schema, expectation) {
    const column = columnByName(schema, expectation.table, expectation.column);
    expect(column, `${expectation.table}.${expectation.column}`).toBeTruthy();

    if (expectation.type) expect(column.type).toBe(expectation.type);
    assertContainsAll(column.constraints, expectation.constraints);

    for (const extraNeedle of expectation.extras || []) {
        expect(column.extras.some((extra) => extra.includes(extraNeedle)), `${expectation.table}.${expectation.column} extra ${extraNeedle}`).toBe(true);
    }

    for (const flag of expectation.flags || []) {
        expect(column[flag], `${expectation.table}.${expectation.column}.${flag}`).toBe(true);
    }
}

function coreShape(schema) {
    return {
        tables: schema.tables.map((table) => table.name),
        relations: relationKeys(schema),
        enums: schema.enums.map((type) => type.name),
        composites: schema.composites.map((type) => type.name),
    };
}

describe('user SQL fixture corpus - discovery', () => {
    it('keeps the manifest synchronized with messy user fixture files', () => {
        const discovered = readdirSync(fixtureDir)
            .filter((file) => file.endsWith('.sql'))
            .sort();
        const listed = fixtures.map((fixture) => fixture.fixture).sort();

        expect(listed).toEqual(discovered);
    });
});

describe('user SQL fixture corpus - parseAST', () => {
    it.each(fixtures)('parses $fixture without diagnostics and preserves user-facing AST contracts', (fixture) => {
        const parsed = parseAST(readFixture(fixture.fixture));

        expect(parsed.errors).toEqual([]);
        expect(astTableNames(parsed)).toEqual(fixture.tables);
        expect(astTypeNames(parsed)).toEqual(fixture.types || []);
        assertContainsAll(astIndexNames(parsed), fixture.indexes);
        assertContainsAll(astForeignNames(parsed), fixture.foreignNames);

        for (const columnExpectation of fixture.columns) {
            const table = parsed.ast.tables.find((item) => stripSchema(item.name) === columnExpectation.table);
            expect(table?.columns.some((column) => column.name === columnExpectation.column), `${fixture.fixture}:${columnExpectation.table}.${columnExpectation.column}`).toBe(true);
        }
    });
});

describe('user SQL fixture corpus - sqlToErdSchema', () => {
    it.each(fixtures)('converts $fixture into a renderable ERD contract', (fixture) => {
        const schema = sqlToErdSchema(readFixture(fixture.fixture));

        assertRenderable(schema);
        expect(schema._parseErrors).toEqual([]);
        expect(schema.tables.map((table) => table.name)).toEqual(fixture.schemaTables || fixture.tables);
        expect(schema.enums.map((type) => type.name).concat(schema.composites.map((type) => type.name))).toEqual(fixture.types || []);
        assertContainsAll(relationKeys(schema), fixture.relations);
        expect(schema.relations).toHaveLength(fixture.relations.length);

        for (const columnExpectation of fixture.columns) {
            assertColumn(schema, columnExpectation);
        }
    });

    it.each(fixtures)('marks every expected relation source as an FK column in $fixture', (fixture) => {
        const schema = sqlToErdSchema(readFixture(fixture.fixture));

        for (const relationKey of fixture.relations) {
            const source = relationKey.split(':').pop().split('->')[0];
            const [table, column] = splitQualifiedColumnRef(source);
            expect(columnByName(schema, table, column)?.fk, `${fixture.fixture}:${source}`).toBe(true);
        }
    });

    it.each(fixtureCases)('keeps the ERD core stable for $name', ({ fixture, perturbation }) => {
        const sql = readFixture(fixture.fixture);
        const baseline = coreShape(sqlToErdSchema(sql));
        const perturbedSchema = sqlToErdSchema(perturbation.apply(sql));

        expect(perturbedSchema._parseErrors).toEqual([]);
        expect(coreShape(perturbedSchema)).toEqual(baseline);
    });

    it.each(fixtures)('is deterministic and JSON-safe for $fixture', (fixture) => {
        const sql = readFixture(fixture.fixture);
        const first = coreShape(sqlToErdSchema(sql));
        const second = coreShape(sqlToErdSchema(sql));

        expect(second).toEqual(first);
        expect(JSON.parse(JSON.stringify(second))).toEqual(second);
    });
});
