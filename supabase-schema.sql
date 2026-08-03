create table if not exists public.books (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  author text,
  source text not null default 'manual',
  external_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  type text not null check (type in ('体会', '摘句', 'random')),
  text text not null,
  source text not null default 'manual',
  external_id text,
  created_at timestamptz not null default now()
);

alter table public.books add column if not exists source text not null default 'manual';
alter table public.books add column if not exists external_id text;
alter table public.notes add column if not exists source text not null default 'manual';
alter table public.notes add column if not exists external_id text;

create unique index if not exists books_user_source_external_idx
on public.books (user_id, source, external_id)
where external_id is not null;

create unique index if not exists notes_user_source_external_idx
on public.notes (user_id, source, external_id)
where external_id is not null;

alter table public.books enable row level security;
alter table public.notes enable row level security;

drop policy if exists "Users can read own books" on public.books;
drop policy if exists "Users can insert own books" on public.books;
drop policy if exists "Users can update own books" on public.books;
drop policy if exists "Users can delete own books" on public.books;

create policy "Users can read own books"
on public.books for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can insert own books"
on public.books for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update own books"
on public.books for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete own books"
on public.books for delete
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can read own notes" on public.notes;
drop policy if exists "Users can insert own notes" on public.notes;
drop policy if exists "Users can update own notes" on public.notes;
drop policy if exists "Users can delete own notes" on public.notes;

create policy "Users can read own notes"
on public.notes for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can insert own notes"
on public.notes for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.books
    where books.id = notes.book_id
    and books.user_id = (select auth.uid())
  )
);

create policy "Users can update own notes"
on public.notes for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete own notes"
on public.notes for delete
to authenticated
using ((select auth.uid()) = user_id);
