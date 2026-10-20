-- READ ONLY. Run in the existing project's SQL editor or a permitted read-only connection.
-- Do not apply any migration until history AND existing object definitions have been compared.
-- If schema_migrations is absent, its SELECT will error: this means history is unavailable,
-- not proof that the application tables are absent. Run the catalog queries separately.
select version, name from supabase_migrations.schema_migrations order by version;

select n.nspname as schema_name,c.relname as table_name,c.relrowsecurity as rls_enabled,
       pg_get_userbyid(c.relowner) as owner
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname in ('public','storage') and c.relkind='r'
order by n.nspname,c.relname;

select schemaname,tablename,policyname,roles,cmd,qual,with_check
from pg_policies where schemaname in ('public','storage')
order by schemaname,tablename,policyname;

select table_schema,table_name,grantee,privilege_type
from information_schema.role_table_grants
where table_schema in ('public','storage') and grantee in ('anon','authenticated')
order by table_schema,table_name,grantee,privilege_type;

select n.nspname,p.proname,p.prosecdef,p.proconfig,p.proacl,
       pg_get_functiondef(p.oid) as definition
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where (n.nspname='private' and p.proname in ('workspace_role','create_workspace','create_mission','transition_mission'))
   or (n.nspname='public' and p.proname in ('create_workspace','create_mission','transition_mission'))
order by n.nspname,p.proname;

select conrelid::regclass as table_name,conname,pg_get_constraintdef(oid) as definition
from pg_constraint where connamespace='public'::regnamespace
order by conrelid::regclass::text,conname;

select id,name,public from storage.buckets where id='artifacts';
