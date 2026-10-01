-- crestra Buchhaltung – Speicher für Belege (Fotos, PDFs)
-- Privater Bucket; jede Datei liegt unter <Nutzer-ID>/… und ist nur für diesen Nutzer sichtbar.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('belege', 'belege', false, 15728640, array['image/jpeg','image/png','image/heic','image/heif','image/webp','application/pdf','application/xml','text/xml'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "belege lesen" on storage.objects;
drop policy if exists "belege hochladen" on storage.objects;
drop policy if exists "belege aendern" on storage.objects;
drop policy if exists "belege loeschen" on storage.objects;
create policy "belege lesen" on storage.objects for select to authenticated
  using (bucket_id = 'belege' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "belege hochladen" on storage.objects for insert to authenticated
  with check (bucket_id = 'belege' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "belege aendern" on storage.objects for update to authenticated
  using (bucket_id = 'belege' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "belege loeschen" on storage.objects for delete to authenticated
  using (bucket_id = 'belege' and (storage.foldername(name))[1] = auth.uid()::text);
