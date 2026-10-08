-- =====================================================================
-- FreeGuessr database schema
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to re-run: it creates what is missing and replaces functions.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      text not null check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  games_played  int  not null default 0,
  best_score    int  not null default 0,
  duel_wins     int  not null default 0,
  duel_losses   int  not null default 0,
  created_at    timestamptz not null default now()
);
create unique index if not exists profiles_username_lower on public.profiles (lower(username));

create table if not exists public.games (
  id            uuid primary key default gen_random_uuid(),
  code          text unique,
  mode          text not null check (mode in ('solo','party','duel','daily')),
  host_id       uuid not null references public.profiles(id) on delete cascade,
  status        text not null default 'lobby' check (status in ('lobby','playing','finished')),
  total_rounds  int  not null default 5  check (total_rounds between 1 and 50),
  time_limit    int  not null default 0  check (time_limit between 0 and 600),  -- seconds, 0 = unlimited
  move_mode     text not null default 'move' check (move_mode in ('move','nomove')),
  current_round int  not null default 0,
  daily_date    date,
  winner_id     uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists games_one_daily_per_user on public.games (daily_date, host_id) where mode = 'daily';
create index if not exists games_daily_lookup on public.games (daily_date, status) where mode = 'daily';

create table if not exists public.game_players (
  game_id       uuid not null references public.games(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  username      text not null,
  total_score   int  not null default 0,
  health        int  not null default 6000,
  guessed_round int  not null default 0,   -- last round number this player has guessed in
  joined_at     timestamptz not null default now(),
  primary key (game_id, user_id)
);
create index if not exists game_players_user on public.game_players (user_id);

create table if not exists public.rounds (
  game_id     uuid not null references public.games(id) on delete cascade,
  round_no    int  not null,
  image_id    text not null,
  started_at  timestamptz not null default now(),
  deadline    timestamptz,
  ended_at    timestamptz,
  multiplier  numeric not null default 1,
  primary key (game_id, round_no)
);

-- Hidden: the true location of each round. Only readable through functions.
create table if not exists public.round_answers (
  game_id   uuid not null,
  round_no  int  not null,
  lat       double precision not null,
  lng       double precision not null,
  primary key (game_id, round_no),
  foreign key (game_id, round_no) references public.rounds(game_id, round_no) on delete cascade
);

-- Hidden: guesses. Only readable through functions once a round has ended.
create table if not exists public.guesses (
  game_id      uuid not null,
  round_no     int  not null,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  lat          double precision,           -- null = ran out of time
  lng          double precision,
  distance_km  double precision,
  score        int  not null default 0,
  damage       int  not null default 0,    -- duels: damage this player took this round
  created_at   timestamptz not null default now(),
  primary key (game_id, round_no, user_id),
  foreign key (game_id, round_no) references public.rounds(game_id, round_no) on delete cascade
);

-- Hidden: the five daily challenge locations.
create table if not exists public.daily_locations (
  day       date not null,
  round_no  int  not null check (round_no between 1 and 5),
  image_id  text not null,
  lat       double precision not null,
  lng       double precision not null,
  primary key (day, round_no)
);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

create or replace function public.is_player(p_game uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.game_players where game_id = p_game and user_id = auth.uid());
$$;

create or replace function public.haversine_km(lat1 double precision, lng1 double precision,
                                               lat2 double precision, lng2 double precision)
returns double precision language sql immutable as $$
  select 2 * 6371.0088 * asin(least(1.0, sqrt(
           power(sin(radians(lat2 - lat1) / 2), 2) +
           cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))));
$$;

create or replace function public.score_for_km(d double precision)
returns int language sql immutable as $$
  select case when d is null then 0
              when d <= 0.025 then 5000
              else greatest(0, round(5000 * exp(-d / 1492.7)))::int end;
$$;

create or replace function public.utc_today()
returns date language sql stable as $$ select (now() at time zone 'utc')::date; $$;

create or replace function public.require_uid()
returns uuid language plpgsql stable as $$
declare v uuid := auth.uid();
begin
  if v is null then raise exception 'Please log in first' using errcode = '28000'; end if;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'username', 'player_' || substr(new.id::text, 1, 8)));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.username_available(p_username text)
returns boolean language sql stable security definer set search_path = public as $$
  select p_username ~ '^[A-Za-z0-9_]{3,20}$'
     and not exists (select 1 from public.profiles where lower(username) = lower(p_username));
$$;

create or replace function public.server_now()
returns timestamptz language sql stable as $$ select now(); $$;

-- ---------------------------------------------------------------------
-- Games: create / join / leave / settings
-- ---------------------------------------------------------------------

create or replace function public.new_game_code()
returns text language plpgsql volatile set search_path = public as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  c text;
begin
  loop
    c := '';
    for i in 1..6 loop
      c := c || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.games where code = c);
  end loop;
  return c;
end $$;

create or replace function public.create_game(p_mode text, p_rounds int default 5,
                                              p_time_limit int default 0, p_move_mode text default 'move')
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := public.require_uid();
  v_name text;
  v_id   uuid;
begin
  if p_mode not in ('solo','party','duel') then raise exception 'Unknown game mode'; end if;
  select username into v_name from public.profiles where id = v_uid;
  if v_name is null then raise exception 'Profile not found'; end if;

  if p_mode = 'duel' then
    p_rounds := 50;                                     -- duels end on health, not round count
    p_time_limit := greatest(10, coalesce(nullif(p_time_limit, 0), 60));  -- duels must be timed
  else
    p_rounds := least(20, greatest(1, coalesce(p_rounds, 5)));
    p_time_limit := least(600, greatest(0, coalesce(p_time_limit, 0)));
  end if;
  if p_move_mode not in ('move','nomove') then p_move_mode := 'move'; end if;

  insert into public.games (code, mode, host_id, total_rounds, time_limit, move_mode)
  values (case when p_mode = 'solo' then null else public.new_game_code() end,
          p_mode, v_uid, p_rounds, p_time_limit, p_move_mode)
  returning id into v_id;

  insert into public.game_players (game_id, user_id, username) values (v_id, v_uid, v_name);
  return v_id;
end $$;

create or replace function public.join_game(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := public.require_uid();
  v_name text;
  g      public.games%rowtype;
  n      int;
begin
  select * into g from public.games where code = upper(trim(p_code)) for update;
  if not found then raise exception 'No game with that code'; end if;
  if exists (select 1 from public.game_players where game_id = g.id and user_id = v_uid) then
    return g.id;
  end if;
  if g.status <> 'lobby' then raise exception 'That game has already started'; end if;
  select count(*) into n from public.game_players where game_id = g.id;
  if g.mode = 'duel' and n >= 2 then raise exception 'That duel is full'; end if;
  if n >= 16 then raise exception 'That room is full (16 players)'; end if;
  select username into v_name from public.profiles where id = v_uid;
  insert into public.game_players (game_id, user_id, username) values (g.id, v_uid, v_name);
  update public.games set updated_at = now() where id = g.id;
  return g.id;
end $$;

create or replace function public.leave_game(p_game uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_uid();
  g     public.games%rowtype;
begin
  select * into g from public.games where id = p_game for update;
  if not found or g.status <> 'lobby' then return; end if;   -- mid-game: you simply stop guessing
  if g.host_id = v_uid then
    delete from public.games where id = p_game;            -- host closes the lobby
  else
    delete from public.game_players where game_id = p_game and user_id = v_uid;
    update public.games set updated_at = now() where id = p_game;
  end if;
end $$;

create or replace function public.update_settings(p_game uuid, p_rounds int, p_time_limit int, p_move_mode text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_uid();
  g     public.games%rowtype;
begin
  select * into g from public.games where id = p_game for update;
  if not found or g.host_id <> v_uid then raise exception 'Only the host can change settings'; end if;
  if g.status <> 'lobby' then raise exception 'The game has already started'; end if;
  if g.mode = 'duel' then
    p_rounds := 50;
    p_time_limit := greatest(10, coalesce(nullif(p_time_limit, 0), 60));
  else
    p_rounds := least(20, greatest(1, coalesce(p_rounds, 5)));
  end if;
  update public.games
     set total_rounds = p_rounds,
         time_limit   = least(600, greatest(0, coalesce(p_time_limit, 0))),
         move_mode    = case when p_move_mode in ('move','nomove') then p_move_mode else move_mode end,
         updated_at   = now()
   where id = p_game;
end $$;

-- ---------------------------------------------------------------------
-- Rounds
-- ---------------------------------------------------------------------

-- Duel damage multiplier: x1 for rounds 1-4, then +0.5 per round.
create or replace function public.duel_multiplier(r int)
returns numeric language sql immutable as $$
  select case when r <= 4 then 1.0 else 1.0 + 0.5 * (r - 4) end;
$$;

-- Starts round p_round (must be exactly the next round). Idempotent: if that
-- round already exists it simply returns it, so two clients racing is harmless.
create or replace function public.start_round(p_game uuid, p_round int, p_image_id text,
                                              p_lat double precision, p_lng double precision)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := public.require_uid();
  g       public.games%rowtype;
  prev    public.rounds%rowtype;
  n       int;
  d       public.daily_locations%rowtype;
begin
  select * into g from public.games where id = p_game for update;
  if not found or not exists (select 1 from public.game_players where game_id = p_game and user_id = v_uid) then
    raise exception 'You are not in this game';
  end if;
  if g.current_round >= p_round then return g.current_round; end if;   -- already started by someone
  if g.status = 'finished' then raise exception 'The game is over'; end if;
  if p_round <> g.current_round + 1 then raise exception 'Wrong round number'; end if;
  if p_round > g.total_rounds then raise exception 'No more rounds'; end if;

  if g.current_round = 0 then
    if g.host_id <> v_uid then raise exception 'Only the host can start the game'; end if;
    select count(*) into n from public.game_players where game_id = p_game;
    if g.mode = 'duel' and n < 2 then raise exception 'Waiting for an opponent to join'; end if;
  else
    select * into prev from public.rounds where game_id = p_game and round_no = g.current_round;
    if prev.ended_at is null then raise exception 'The current round has not finished'; end if;
    -- Normally the host advances; anyone may if the host has stalled for 20s.
    if g.host_id <> v_uid and now() < prev.ended_at + interval '20 seconds' then
      raise exception 'Waiting for the host';
    end if;
  end if;

  if g.mode = 'daily' then
    select * into d from public.daily_locations where day = g.daily_date and round_no = p_round;
    if not found then raise exception 'Daily challenge locations missing'; end if;
    p_image_id := d.image_id; p_lat := d.lat; p_lng := d.lng;
  end if;

  if p_image_id is null or p_image_id !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'Bad image id'; end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'Bad coordinates';
  end if;

  insert into public.rounds (game_id, round_no, image_id, started_at, deadline, multiplier)
  values (p_game, p_round, p_image_id, now(),
          case when g.time_limit > 0 then now() + make_interval(secs => g.time_limit) end,
          case when g.mode = 'duel' then public.duel_multiplier(p_round) else 1 end);
  insert into public.round_answers (game_id, round_no, lat, lng) values (p_game, p_round, p_lat, p_lng);

  update public.games set current_round = p_round, status = 'playing', updated_at = now() where id = p_game;
  return p_round;
end $$;

-- Internal: closes a round, fills in missed guesses, applies scores/damage and
-- finishes the game if it is over. Caller must hold the game row lock.
create or replace function public._finish_round(p_game uuid, p_round int)
returns void language plpgsql security definer set search_path = public as $$
declare
  g        public.games%rowtype;
  r        public.rounds%rowtype;
  a        record;
  b        record;
  dmg      int;
  finished boolean := false;
  v_winner uuid;
begin
  select * into g from public.games where id = p_game;
  select * into r from public.rounds where game_id = p_game and round_no = p_round;
  if r.ended_at is not null then return; end if;

  update public.rounds set ended_at = now() where game_id = p_game and round_no = p_round;

  insert into public.guesses (game_id, round_no, user_id, lat, lng, distance_km, score)
  select p_game, p_round, gp.user_id, null, null, null, 0
    from public.game_players gp
   where gp.game_id = p_game
  on conflict do nothing;

  update public.game_players gp
     set total_score = gp.total_score + gs.score
    from public.guesses gs
   where gs.game_id = p_game and gs.round_no = p_round
     and gp.game_id = p_game and gp.user_id = gs.user_id;

  if g.mode = 'duel' then
    select gp.user_id, gp.health, gs.score into a
      from public.game_players gp join public.guesses gs
        on gs.game_id = gp.game_id and gs.user_id = gp.user_id and gs.round_no = p_round
     where gp.game_id = p_game order by gp.joined_at, gp.user_id limit 1;
    select gp.user_id, gp.health, gs.score into b
      from public.game_players gp join public.guesses gs
        on gs.game_id = gp.game_id and gs.user_id = gp.user_id and gs.round_no = p_round
     where gp.game_id = p_game and gp.user_id <> a.user_id limit 1;

    if b.user_id is not null and a.score <> b.score then
      dmg := round(abs(a.score - b.score) * r.multiplier)::int;
      if a.score < b.score then
        update public.game_players set health = greatest(0, health - dmg) where game_id = p_game and user_id = a.user_id;
        update public.guesses set damage = dmg where game_id = p_game and round_no = p_round and user_id = a.user_id;
        if a.health - dmg <= 0 then finished := true; v_winner := b.user_id; end if;
      else
        update public.game_players set health = greatest(0, health - dmg) where game_id = p_game and user_id = b.user_id;
        update public.guesses set damage = dmg where game_id = p_game and round_no = p_round and user_id = b.user_id;
        if b.health - dmg <= 0 then finished := true; v_winner := a.user_id; end if;
      end if;
    end if;

    if not finished and p_round >= g.total_rounds then
      finished := true;
      select user_id into v_winner from public.game_players where game_id = p_game
       order by health desc limit 1;
      if (select count(distinct health) from public.game_players where game_id = p_game) = 1 then
        v_winner := null;  -- dead heat
      end if;
    end if;
  elsif p_round >= g.total_rounds then
    finished := true;
    if g.mode = 'party' then
      select user_id into v_winner from public.game_players where game_id = p_game
       order by total_score desc, joined_at limit 1;
    end if;
  end if;

  if finished then
    update public.games set status = 'finished', winner_id = v_winner, updated_at = now() where id = p_game;

    update public.profiles p set games_played = p.games_played + 1
      from public.game_players gp where gp.game_id = p_game and gp.user_id = p.id;

    if g.mode = 'duel' then
      if v_winner is not null then
        update public.profiles set duel_wins = duel_wins + 1 where id = v_winner;
        update public.profiles p set duel_losses = p.duel_losses + 1
          from public.game_players gp
         where gp.game_id = p_game and gp.user_id = p.id and p.id <> v_winner;
      end if;
    elsif g.total_rounds = 5 then
      update public.profiles p set best_score = greatest(p.best_score, gp.total_score)
        from public.game_players gp where gp.game_id = p_game and gp.user_id = p.id;
    end if;
  else
    update public.games set updated_at = now() where id = p_game;
  end if;
end $$;

create or replace function public.submit_guess(p_game uuid, p_round int, p_lat double precision, p_lng double precision)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := public.require_uid();
  g      public.games%rowtype;
  r      public.rounds%rowtype;
  ans    public.round_answers%rowtype;
  v_km   double precision;
  v_sc   int;
  n_left int;
begin
  select * into g from public.games where id = p_game for update;
  if not found or not exists (select 1 from public.game_players where game_id = p_game and user_id = v_uid) then
    raise exception 'You are not in this game';
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 then raise exception 'Bad coordinates'; end if;
  p_lng := ((p_lng + 180)::numeric % 360 + 360) % 360 - 180;   -- wrap longitudes from a scrolled map

  select * into r from public.rounds where game_id = p_game and round_no = p_round;
  if not found or p_round <> g.current_round then raise exception 'That round is not active'; end if;
  if r.ended_at is not null then raise exception 'That round has ended'; end if;
  if r.deadline is not null and now() > r.deadline + interval '2 seconds' then
    raise exception 'Time is up';   -- the client then calls end_round
  end if;

  select * into ans from public.round_answers where game_id = p_game and round_no = p_round;
  v_km := public.haversine_km(ans.lat, ans.lng, p_lat, p_lng);
  v_sc := public.score_for_km(v_km);

  insert into public.guesses (game_id, round_no, user_id, lat, lng, distance_km, score)
  values (p_game, p_round, v_uid, p_lat, p_lng, v_km, v_sc)
  on conflict do nothing;
  if not found then raise exception 'You already guessed this round'; end if;

  update public.game_players set guessed_round = p_round where game_id = p_game and user_id = v_uid;

  select count(*) into n_left from public.game_players gp
   where gp.game_id = p_game
     and not exists (select 1 from public.guesses gs
                      where gs.game_id = p_game and gs.round_no = p_round and gs.user_id = gp.user_id);

  if n_left = 0 then
    perform public._finish_round(p_game, p_round);
  elsif g.mode = 'duel' and (r.deadline is null or r.deadline > now() + interval '15 seconds') then
    update public.rounds set deadline = now() + interval '15 seconds' where game_id = p_game and round_no = p_round;
  end if;

  return json_build_object('distance_km', v_km, 'score', v_sc);
end $$;

-- Ends a round once everyone has guessed or time is up. Any player may call it
-- (clients call it when their timer hits zero). The host may force it early.
create or replace function public.end_round(p_game uuid, p_round int, p_force boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := public.require_uid();
  g      public.games%rowtype;
  r      public.rounds%rowtype;
  n_left int;
begin
  select * into g from public.games where id = p_game for update;
  if not found or not exists (select 1 from public.game_players where game_id = p_game and user_id = v_uid) then
    raise exception 'You are not in this game';
  end if;
  select * into r from public.rounds where game_id = p_game and round_no = p_round;
  if not found then raise exception 'No such round'; end if;
  if r.ended_at is not null then return; end if;

  select count(*) into n_left from public.game_players gp
   where gp.game_id = p_game
     and not exists (select 1 from public.guesses gs
                      where gs.game_id = p_game and gs.round_no = p_round and gs.user_id = gp.user_id);

  if n_left > 0
     and (r.deadline is null or now() < r.deadline)
     and not (p_force and g.host_id = v_uid and g.mode <> 'duel') then
    raise exception 'Round still in progress';
  end if;

  perform public._finish_round(p_game, p_round);
end $$;

create or replace function public.round_result_json(p_game uuid, p_round int)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'round_no',   r.round_no,
    'image_id',   r.image_id,
    'multiplier', r.multiplier,
    'answer',     json_build_object('lat', a.lat, 'lng', a.lng),
    'guesses', coalesce((
       select json_agg(json_build_object(
                'user_id', gs.user_id, 'username', gp.username,
                'lat', gs.lat, 'lng', gs.lng, 'distance_km', gs.distance_km,
                'score', gs.score, 'damage', gs.damage)
              order by gs.score desc, gp.username)
         from public.guesses gs
         join public.game_players gp on gp.game_id = gs.game_id and gp.user_id = gs.user_id
        where gs.game_id = p_game and gs.round_no = p_round), '[]'::json))
  from public.rounds r join public.round_answers a using (game_id, round_no)
  where r.game_id = p_game and r.round_no = p_round;
$$;

create or replace function public.get_round_result(p_game uuid, p_round int)
returns json language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := public.require_uid();
begin
  if not exists (select 1 from public.game_players where game_id = p_game and user_id = v_uid) then
    raise exception 'You are not in this game';
  end if;
  if not exists (select 1 from public.rounds where game_id = p_game and round_no = p_round and ended_at is not null) then
    raise exception 'Round not finished yet';
  end if;
  return public.round_result_json(p_game, p_round);
end $$;

create or replace function public.get_game_summary(p_game uuid)
returns json language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := public.require_uid();
begin
  if not exists (select 1 from public.game_players where game_id = p_game and user_id = v_uid) then
    raise exception 'You are not in this game';
  end if;
  return json_build_object(
    'rounds', coalesce((select json_agg(public.round_result_json(p_game, r.round_no) order by r.round_no)
                          from public.rounds r where r.game_id = p_game and r.ended_at is not null), '[]'::json),
    'players', coalesce((select json_agg(json_build_object('user_id', user_id, 'username', username,
                                   'total_score', total_score, 'health', health) order by total_score desc, health desc)
                          from public.game_players where game_id = p_game), '[]'::json));
end $$;

create or replace function public.my_active_games()
returns table (id uuid, mode text, code text, status text, current_round int, total_rounds int, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select g.id, g.mode, g.code, g.status, g.current_round, g.total_rounds, g.updated_at
    from public.games g join public.game_players gp on gp.game_id = g.id
   where gp.user_id = auth.uid() and g.status <> 'finished' and g.mode <> 'daily'
     and g.updated_at > now() - interval '1 day'
   order by g.updated_at desc limit 10;
$$;

-- ---------------------------------------------------------------------
-- Daily challenge
-- ---------------------------------------------------------------------

-- The first player of the day supplies 5 locations; everyone after gets the same ones.
create or replace function public.seed_daily(p_locations jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_uid();
  v_day date := public.utc_today();
  i     int;
  loc   jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('freeguessr_daily_' || v_day::text));
  if exists (select 1 from public.daily_locations where day = v_day) then return; end if;
  if jsonb_typeof(p_locations) <> 'array' or jsonb_array_length(p_locations) <> 5 then
    raise exception 'Need exactly 5 locations';
  end if;
  for i in 0..4 loop
    loc := p_locations -> i;
    if (loc ->> 'image_id') !~ '^[A-Za-z0-9_-]{1,64}$'
       or (loc ->> 'lat')::double precision not between -90 and 90
       or (loc ->> 'lng')::double precision not between -180 and 180 then
      raise exception 'Bad location %', i + 1;
    end if;
    insert into public.daily_locations (day, round_no, image_id, lat, lng)
    values (v_day, i + 1, loc ->> 'image_id', (loc ->> 'lat')::double precision, (loc ->> 'lng')::double precision);
  end loop;
end $$;

create or replace function public.daily_status()
returns json language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := public.require_uid();
  v_day date := public.utc_today();
  g     public.games%rowtype;
begin
  select * into g from public.games where mode = 'daily' and daily_date = v_day and host_id = v_uid;
  return json_build_object(
    'day',     v_day,
    'seeded',  exists (select 1 from public.daily_locations where day = v_day),
    'game_id', g.id,
    'status',  g.status,
    'score',   (select total_score from public.game_players where game_id = g.id and user_id = v_uid));
end $$;

create or replace function public.start_daily()
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := public.require_uid();
  v_day  date := public.utc_today();
  v_name text;
  v_id   uuid;
begin
  if (select count(*) from public.daily_locations where day = v_day) <> 5 then
    raise exception 'Today''s challenge is not ready yet';
  end if;
  select id into v_id from public.games where mode = 'daily' and daily_date = v_day and host_id = v_uid;
  if v_id is not null then return v_id; end if;

  select username into v_name from public.profiles where id = v_uid;
  insert into public.games (mode, host_id, total_rounds, time_limit, move_mode, daily_date)
  values ('daily', v_uid, 5, 0, 'move', v_day)
  on conflict do nothing
  returning id into v_id;
  if v_id is null then  -- lost a race with ourselves (double click)
    select id into v_id from public.games where mode = 'daily' and daily_date = v_day and host_id = v_uid;
    return v_id;
  end if;
  insert into public.game_players (game_id, user_id, username) values (v_id, v_uid, v_name);
  return v_id;
end $$;

create or replace function public.get_daily_leaderboard(p_day date default null)
returns table (rank bigint, username text, score int, finished_at timestamptz)
language sql stable security definer set search_path = public as $$
  select rank() over (order by gp.total_score desc), gp.username, gp.total_score, g.updated_at
    from public.games g join public.game_players gp on gp.game_id = g.id
   where g.mode = 'daily' and g.daily_date = coalesce(p_day, public.utc_today()) and g.status = 'finished'
   order by gp.total_score desc, g.updated_at
   limit 50;
$$;

-- ---------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------

alter table public.profiles        enable row level security;
alter table public.games           enable row level security;
alter table public.game_players    enable row level security;
alter table public.rounds          enable row level security;
alter table public.round_answers   enable row level security;  -- no policies: functions only
alter table public.guesses         enable row level security;  -- no policies: functions only
alter table public.daily_locations enable row level security;  -- no policies: functions only

drop policy if exists "profiles are public"        on public.profiles;
drop policy if exists "players see their games"    on public.games;
drop policy if exists "players see their roster"   on public.game_players;
drop policy if exists "players see their rounds"   on public.rounds;

create policy "profiles are public"      on public.profiles     for select to anon, authenticated using (true);
create policy "players see their games"  on public.games        for select to authenticated using (public.is_player(id));
create policy "players see their roster" on public.game_players for select to authenticated using (public.is_player(game_id));
create policy "players see their rounds" on public.rounds       for select to authenticated using (public.is_player(game_id));

-- All writes go through the functions above.
revoke insert, update, delete on public.profiles, public.games, public.game_players, public.rounds,
  public.round_answers, public.guesses, public.daily_locations from anon, authenticated;

-- ---------------------------------------------------------------------
-- Function permissions
-- ---------------------------------------------------------------------

-- Supabase grants execute on new functions to everyone by default, so lock
-- every FreeGuessr function down first, then open up only the public API.
do $$
declare f text;
begin
  foreach f in array array[
    'is_player(uuid)', 'haversine_km(double precision,double precision,double precision,double precision)',
    'score_for_km(double precision)', 'utc_today()', 'require_uid()', 'handle_new_user()',
    'username_available(text)', 'server_now()', 'new_game_code()', 'create_game(text,int,int,text)',
    'join_game(text)', 'leave_game(uuid)', 'update_settings(uuid,int,int,text)', 'duel_multiplier(int)',
    'start_round(uuid,int,text,double precision,double precision)', '_finish_round(uuid,int)',
    'submit_guess(uuid,int,double precision,double precision)', 'end_round(uuid,int,boolean)',
    'round_result_json(uuid,int)', 'get_round_result(uuid,int)', 'get_game_summary(uuid)',
    'my_active_games()', 'seed_daily(jsonb)', 'daily_status()', 'start_daily()', 'get_daily_leaderboard(date)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

grant execute on function public.username_available(text)          to anon, authenticated;
grant execute on function public.server_now()                      to anon, authenticated;
grant execute on function public.get_daily_leaderboard(date)       to anon, authenticated;
grant execute on function public.is_player(uuid)                   to authenticated;
grant execute on function public.create_game(text, int, int, text) to authenticated;
grant execute on function public.join_game(text)                   to authenticated;
grant execute on function public.leave_game(uuid)                  to authenticated;
grant execute on function public.update_settings(uuid, int, int, text) to authenticated;
grant execute on function public.start_round(uuid, int, text, double precision, double precision) to authenticated;
grant execute on function public.submit_guess(uuid, int, double precision, double precision)      to authenticated;
grant execute on function public.end_round(uuid, int, boolean)     to authenticated;
grant execute on function public.get_round_result(uuid, int)       to authenticated;
grant execute on function public.get_game_summary(uuid)            to authenticated;
grant execute on function public.my_active_games()                 to authenticated;
grant execute on function public.seed_daily(jsonb)                 to authenticated;
grant execute on function public.daily_status()                    to authenticated;
grant execute on function public.start_daily()                     to authenticated;

-- ---------------------------------------------------------------------
-- Realtime: push changes to games, rosters and rounds to players
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['games', 'game_players', 'rounds'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
