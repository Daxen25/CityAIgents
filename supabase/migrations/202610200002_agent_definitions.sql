insert into public.agent_definitions(key,version,name,description) values
 ('chief-of-staff',1,'Chief of Staff','Plans missions and coordinates supervised work.'),
 ('researcher',1,'Researcher','Prepares research plans and evidence summaries.'),
 ('developer',1,'Developer','Plans and implements approved software work.')
on conflict(key) do nothing;
