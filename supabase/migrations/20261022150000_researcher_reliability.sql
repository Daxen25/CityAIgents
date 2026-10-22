-- M1.4.1 additive diagnostics only. No historical data/attempt changes or RLS changes.
alter table public.runs add column execution_metadata jsonb;
create function private.validate_researcher_diagnostics(value jsonb) returns boolean
language sql immutable set search_path='' as $$
 select coalesce(jsonb_typeof(value)='object'
 and (select count(*)=6 from jsonb_object_keys(value))
 and value ?& array['provider_requests','retry_performed','http_status','failure_class','provider_elapsed_ms','timeout_source']
 and jsonb_typeof(value->'provider_requests')='number' and (value->>'provider_requests') in ('0','1','2')
 and jsonb_typeof(value->'retry_performed')='boolean'
 and (value->>'retry_performed')::boolean=((value->>'provider_requests')='2')
 and (value->'http_status'='null'::jsonb or (jsonb_typeof(value->'http_status')='number' and value->>'http_status' ~ '^[1-5][0-9]{2}$'))
 and (value->'failure_class'='null'::jsonb or (jsonb_typeof(value->'failure_class')='string' and value->>'failure_class' in ('invalid_request_or_schema','authentication','permission_denied','model_or_endpoint_unavailable','quota_or_rate_limit','server_error','http_error')))
 and jsonb_typeof(value->'provider_elapsed_ms')='number' and value->>'provider_elapsed_ms' ~ '^[0-9]{1,6}$'
 and (value->>'provider_elapsed_ms')::numeric between 0 and 120000
 and (value->'timeout_source'='null'::jsonb or (jsonb_typeof(value->'timeout_source')='string' and value->>'timeout_source' in ('application_deadline','transport_timeout','transport_error'))),false)
$$;
alter table public.runs add constraint researcher_diagnostics_context check(execution_metadata is null or (purpose='researcher' and private.validate_researcher_diagnostics(execution_metadata)));
-- New name preserves old five-argument RPC compatibility without overload ambiguity.
create function private.finish_researcher_execution_with_diagnostics(rid uuid,token_hash text,doc jsonb,error_code text,model_version text,execution_metadata jsonb) returns void
language plpgsql security definer set search_path='' as $$ begin
 if execution_metadata is null or not private.validate_researcher_diagnostics(execution_metadata) then raise exception 'Invalid execution diagnostics'; end if;
 perform private.finish_researcher_execution(rid,token_hash,doc,error_code,model_version);
 update public.runs set execution_metadata=finish_researcher_execution_with_diagnostics.execution_metadata where id=rid;
end $$;
create function public.finish_researcher_execution_with_diagnostics(rid uuid,token_hash text,doc jsonb,error_code text,model_version text,execution_metadata jsonb) returns void
language sql security invoker set search_path='' as $$ select private.finish_researcher_execution_with_diagnostics(rid,token_hash,doc,error_code,model_version,execution_metadata) $$;
revoke all on function private.validate_researcher_diagnostics(jsonb),private.finish_researcher_execution_with_diagnostics(uuid,text,jsonb,text,text,jsonb),public.finish_researcher_execution_with_diagnostics(uuid,text,jsonb,text,text,jsonb) from public,anon,authenticated;
grant execute on function private.finish_researcher_execution_with_diagnostics(uuid,text,jsonb,text,text,jsonb),public.finish_researcher_execution_with_diagnostics(uuid,text,jsonb,text,text,jsonb) to service_role;
-- Constraint evaluation requires this pure validator; it has no table access or mutation.
grant execute on function private.validate_researcher_diagnostics(jsonb) to service_role;
