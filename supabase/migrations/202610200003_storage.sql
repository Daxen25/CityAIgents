-- Private bucket, readable by members only. Upload/update/delete are intentionally denied in M0.
insert into storage.buckets(id,name,public) values('artifacts','artifacts',false) on conflict(id) do nothing;
create policy workspace_artifact_read on storage.objects for select to authenticated
using(bucket_id='artifacts' and exists (
 select 1 from public.workspaces w
 where w.id::text=(storage.foldername(storage.objects.name))[1] and private.workspace_role(w.id) is not null
));
