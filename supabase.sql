-- =====================================================================
-- Copilote Route : base de données (Supabase / PostgreSQL)
-- À coller une seule fois dans Supabase > SQL Editor > Run
-- =====================================================================

-- 1. Réglages (une seule ligne)
create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  price_fcfa int not null default 1500,
  trial_days int not null default 7,
  wave_number text not null default '',
  om_number text not null default '',
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict do nothing;

-- 2. Profils des utilisateurs
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  phone text unique not null,
  full_name text not null default '',
  role text not null default 'user' check (role in ('user','admin')),
  blocked boolean not null default false,
  trial_ends_at timestamptz not null,
  paid_until timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

-- 3. Paiements
create table if not exists public.payments (
  id bigserial primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount_fcfa int not null check (amount_fcfa > 0),
  months int not null default 1 check (months between 1 and 12),
  method text not null check (method in ('wave','orange_money','especes','autre')),
  reference text not null default '',
  status text not null default 'pending' check (status in ('pending','validated','rejected')),
  created_at timestamptz not null default now(),
  validated_at timestamptz
);
create index if not exists payments_status_idx on public.payments(status);

-- 4. Est-ce un administrateur ?
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

-- 5. Création automatique du profil à l'inscription (essai gratuit)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare d int;
begin
  select trial_days into d from settings where id = 1;
  insert into profiles (id, phone, full_name, trial_ends_at)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'phone', split_part(new.email,'@',1)),
          coalesce(new.raw_user_meta_data->>'full_name',''),
          now() + make_interval(days => coalesce(d,7)));
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 6. "Ai-je le droit d'utiliser le copilote ?" (appelé par l'application)
create or replace function public.my_access() returns json
language plpgsql security definer set search_path = public as $$
declare p profiles; s settings; st text; ends timestamptz;
begin
  select * into p from profiles where id = auth.uid();
  if p.id is null then return json_build_object('status','unknown'); end if;
  select * into s from settings where id = 1;
  update profiles set last_seen_at = now() where id = p.id;
  if p.blocked then st := 'blocked'; ends := null;
  elsif p.paid_until is not null and p.paid_until > now() then st := 'active'; ends := p.paid_until;
  elsif p.trial_ends_at > now() then st := 'trial'; ends := p.trial_ends_at;
  else st := 'expired'; ends := greatest(p.trial_ends_at, coalesce(p.paid_until, p.trial_ends_at));
  end if;
  return json_build_object(
    'status', st, 'ends_at', ends, 'phone', p.phone, 'full_name', p.full_name, 'role', p.role,
    'price_fcfa', s.price_fcfa, 'wave_number', s.wave_number, 'om_number', s.om_number,
    'pending', (select count(*) from payments where user_id = p.id and status = 'pending'));
end $$;

-- 7. Le client déclare un paiement (en attente de validation)
create or replace function public.declare_payment(p_method text, p_reference text, p_months int)
returns void language plpgsql security definer set search_path = public as $$
declare price int;
begin
  if auth.uid() is null then raise exception 'non connecté'; end if;
  select price_fcfa into price from settings where id = 1;
  insert into payments (user_id, amount_fcfa, months, method, reference)
  values (auth.uid(), price * greatest(1, least(p_months, 12)), greatest(1, least(p_months, 12)),
          p_method, left(coalesce(p_reference,''), 80));
end $$;

-- 8. Actions de l'administrateur
create or replace function public.admin_validate_payment(p_id bigint, p_ok boolean)
returns void language plpgsql security definer set search_path = public as $$
declare pay payments;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  select * into pay from payments where id = p_id and status = 'pending' for update;
  if pay.id is null then return; end if;
  if p_ok then
    update payments set status = 'validated', validated_at = now() where id = p_id;
    update profiles set paid_until = greatest(now(), coalesce(paid_until, now())) + make_interval(months => pay.months)
      where id = pay.user_id;
  else
    update payments set status = 'rejected', validated_at = now() where id = p_id;
  end if;
end $$;

create or replace function public.admin_add_days(p_user uuid, p_days int)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  update profiles set paid_until = greatest(now(), coalesce(paid_until, now())) + make_interval(days => p_days)
    where id = p_user;
end $$;

create or replace function public.admin_record_payment(p_user uuid, p_method text, p_months int, p_reference text)
returns void language plpgsql security definer set search_path = public as $$
declare price int; m int := greatest(1, least(p_months, 12));
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  select price_fcfa into price from settings where id = 1;
  insert into payments (user_id, amount_fcfa, months, method, reference, status, validated_at)
  values (p_user, price * m, m, p_method, coalesce(p_reference,''), 'validated', now());
  update profiles set paid_until = greatest(now(), coalesce(paid_until, now())) + make_interval(months => m)
    where id = p_user;
end $$;

-- 9. Sécurité : chacun ne voit que ses données, l'administrateur voit tout
alter table public.settings enable row level security;
alter table public.profiles enable row level security;
alter table public.payments enable row level security;

drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select to authenticated using (true);
drop policy if exists settings_admin on public.settings;
create policy settings_admin on public.settings for update to authenticated using (is_admin()) with check (is_admin());

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (id = auth.uid() or is_admin());
drop policy if exists profiles_admin on public.profiles;
create policy profiles_admin on public.profiles for update to authenticated using (is_admin()) with check (is_admin());

drop policy if exists payments_read on public.payments;
create policy payments_read on public.payments for select to authenticated using (user_id = auth.uid() or is_admin());

revoke all on function public.admin_validate_payment(bigint, boolean) from anon;
revoke all on function public.admin_add_days(uuid, int) from anon;
revoke all on function public.admin_record_payment(uuid, text, int, text) from anon;
revoke all on function public.declare_payment(text, text, int) from anon;
revoke all on function public.my_access() from anon;

-- 10. APRÈS vous être inscrit dans l'application, devenez administrateur :
-- update public.profiles set role = 'admin' where phone = '221XXXXXXXXX';

-- =====================================================================
-- 11. FLOTTES D'ENTREPRISES
-- =====================================================================
create table if not exists public.companies (
  id bigserial primary key,
  name text not null,
  code text unique not null,
  contact_phone text not null default '',
  price_per_vehicle int not null default 4000,
  max_drivers int not null default 5 check (max_drivers > 0),
  paid_until timestamptz,
  created_at timestamptz not null default now()
);
alter table public.profiles add column if not exists company_id bigint references public.companies(id) on delete set null;
alter table public.profiles add column if not exists company_role text check (company_role in ('driver','manager'));

create table if not exists public.trips (
  id bigserial primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  company_id bigint references public.companies(id) on delete set null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  distance_km real not null default 0,
  client_id text unique
);
create table if not exists public.alerts (
  id bigserial primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  company_id bigint references public.companies(id) on delete set null,
  level text not null check (level in ('warn','danger')),
  object text not null default '',
  ttc real,
  lat double precision, lng double precision, speed_kmh real,
  created_at timestamptz not null default now(),
  client_id text unique
);
create index if not exists alerts_company_idx on public.alerts(company_id, created_at desc);
create index if not exists trips_company_idx on public.trips(company_id, started_at desc);

create or replace function public.my_company() returns bigint
language sql stable security definer set search_path = public as $$
  select company_id from profiles where id = auth.uid();
$$;
create or replace function public.is_manager_of(c bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from profiles where id = auth.uid() and company_id = c and company_role = 'manager');
$$;

-- Accès : un chauffeur d'une entreprise à jour est couvert par l'entreprise
create or replace function public.my_access() returns json
language plpgsql security definer set search_path = public as $$
declare p profiles; s settings; c companies; st text; ends timestamptz;
begin
  select * into p from profiles where id = auth.uid();
  if p.id is null then return json_build_object('status','unknown'); end if;
  select * into s from settings where id = 1;
  if p.company_id is not null then select * into c from companies where id = p.company_id; end if;
  update profiles set last_seen_at = now() where id = p.id;
  if p.blocked then st := 'blocked'; ends := null;
  elsif c.id is not null and c.paid_until is not null and c.paid_until > now() then st := 'active'; ends := c.paid_until;
  elsif p.paid_until is not null and p.paid_until > now() then st := 'active'; ends := p.paid_until;
  elsif p.trial_ends_at > now() then st := 'trial'; ends := p.trial_ends_at;
  else st := 'expired'; ends := greatest(p.trial_ends_at, coalesce(p.paid_until, p.trial_ends_at));
  end if;
  return json_build_object(
    'status', st, 'ends_at', ends, 'phone', p.phone, 'full_name', p.full_name, 'role', p.role,
    'price_fcfa', s.price_fcfa, 'wave_number', s.wave_number, 'om_number', s.om_number,
    'company', c.name, 'company_role', p.company_role,
    'pending', (select count(*) from payments where user_id = p.id and status = 'pending'));
end $$;

-- Le chauffeur rejoint son entreprise avec le code
create or replace function public.join_company(p_code text) returns text
language plpgsql security definer set search_path = public as $$
declare c companies; n int;
begin
  if auth.uid() is null then raise exception 'non connecté'; end if;
  select * into c from companies where code = upper(trim(p_code));
  if c.id is null then raise exception 'Code entreprise inconnu'; end if;
  select count(*) into n from profiles where company_id = c.id and company_role = 'driver' and id <> auth.uid();
  if n >= c.max_drivers then raise exception 'Cette entreprise a atteint son nombre maximum de chauffeurs'; end if;
  update profiles set company_id = c.id, company_role = coalesce(case when company_id = c.id then company_role end, 'driver') where id = auth.uid();
  return c.name;
end $$;
create or replace function public.leave_company() returns void
language sql security definer set search_path = public as $$
  update profiles set company_id = null, company_role = null where id = auth.uid();
$$;

-- L'application envoie ses alertes et trajets (par paquets, même après une période hors ligne)
create or replace function public.log_events(p_alerts json, p_trips json) returns void
language plpgsql security definer set search_path = public as $$
declare c bigint;
begin
  if auth.uid() is null then raise exception 'non connecté'; end if;
  select company_id into c from profiles where id = auth.uid();
  insert into alerts (user_id, company_id, level, object, ttc, lat, lng, speed_kmh, created_at, client_id)
  select auth.uid(), c, a->>'level', left(coalesce(a->>'object',''),20), (a->>'ttc')::real,
         (a->>'lat')::float8, (a->>'lng')::float8, (a->>'speed')::real,
         least(now(), coalesce((a->>'at')::timestamptz, now())), a->>'id'
  from json_array_elements(coalesce(p_alerts,'[]'::json)) a
  where a->>'level' in ('warn','danger')
  on conflict (client_id) do nothing;
  insert into trips (user_id, company_id, started_at, ended_at, distance_km, client_id)
  select auth.uid(), c, (t->>'start')::timestamptz, least(now(), (t->>'end')::timestamptz),
         least(2000, greatest(0, coalesce((t->>'km')::real,0))), t->>'id'
  from json_array_elements(coalesce(p_trips,'[]'::json)) t
  on conflict (client_id) do update set ended_at = excluded.ended_at, distance_km = excluded.distance_km;
end $$;

-- Gestion des entreprises par l'administrateur (vous)
create or replace function public.admin_create_company(p_name text, p_contact text, p_price int, p_max int, p_months int)
returns text language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  loop
    k := upper(substr(translate(md5(random()::text || clock_timestamp()::text), '01', ''), 1, 6));
    exit when length(k) = 6 and not exists(select 1 from companies where code = k);
  end loop;
  insert into companies (name, code, contact_phone, price_per_vehicle, max_drivers, paid_until)
  values (trim(p_name), k, coalesce(p_contact,''), greatest(0,p_price), greatest(1,p_max),
          case when p_months > 0 then now() + make_interval(months => p_months) end);
  return k;
end $$;
create or replace function public.admin_company_extend(p_id bigint, p_months int)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  update companies set paid_until = greatest(now(), coalesce(paid_until, now())) + make_interval(months => p_months) where id = p_id;
end $$;
create or replace function public.admin_set_manager(p_company bigint, p_phone text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'réservé à l''administrateur'; end if;
  update profiles set company_id = p_company, company_role = 'manager' where phone = p_phone;
  if not found then raise exception 'Aucun compte avec ce numéro. Le responsable doit d''abord s''inscrire dans l''application.'; end if;
end $$;
-- Le responsable de l'entreprise retire un chauffeur
create or replace function public.manager_remove_driver(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_manager_of(my_company()) then raise exception 'réservé au responsable'; end if;
  update profiles set company_id = null, company_role = null where id = p_user and company_id = my_company() and id <> auth.uid();
end $$;

alter table public.companies enable row level security;
alter table public.trips enable row level security;
alter table public.alerts enable row level security;
drop policy if exists companies_read on public.companies;
create policy companies_read on public.companies for select to authenticated using (is_admin() or id = my_company());
drop policy if exists companies_admin on public.companies;
create policy companies_admin on public.companies for update to authenticated using (is_admin()) with check (is_admin());
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or is_admin() or (company_id is not null and is_manager_of(company_id)));
drop policy if exists alerts_read on public.alerts;
create policy alerts_read on public.alerts for select to authenticated
  using (user_id = auth.uid() or is_admin() or (company_id is not null and is_manager_of(company_id)));
drop policy if exists trips_read on public.trips;
create policy trips_read on public.trips for select to authenticated
  using (user_id = auth.uid() or is_admin() or (company_id is not null and is_manager_of(company_id)));

-- 12. APRÈS vous être inscrit dans l'application, devenez administrateur :
-- update public.profiles set role = 'admin' where phone = '221XXXXXXXXX';
