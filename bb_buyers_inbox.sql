-- Agent version (sent from buyers@dominionlandgroup.land, 2.5% agent commission) of the buy-box email drip (buyers.bb_group = 'Agent'; last_lot = the new build they sold)
create or replace function bb_email(b buyers, step int) returns json language plpgsql stable security definer set search_path=public as $$
declare hi text := 'Hi ' || coalesce(nullif(b.first_name,''), nullif(split_part(coalesce(b.name,''),' ',1),''), 'there') || ',';
  link text := coalesce((select value from app_secrets where name = 'buybox_link'), 'https://dominionlandgroup-hub.github.io/dlg-hq/buybox.html?t=') || coalesce(b.bb_code, b.bb_token::text);
  sig text := E'\n\nDamien Dupee\nDominion Land Group\n(980) 217-8806\nbuyers@dominionlandgroup.land\n\nNot buying lots? Reply "remove" and I will take you off my list.\nDominion Land Group, 1235 East Blvd, Suite C1424, Charlotte, NC 28203';
  subj text; body text; warm boolean := coalesce(b.bb_group,'') = 'Past buyer'; agent boolean := coalesce(b.bb_group,'') = 'Agent';
  sold text := nullif(trim(coalesce(b.last_lot,'')),'');
begin
  -- Agents (from MLS exports): ask about their builder clients, or an intro to the builder's acquisitions manager
  if agent then
    hi := 'Hi ' || coalesce(nullif(b.first_name,''), 'there') || ',';
    sig := replace(sig, 'Not buying lots? Reply "remove"', 'Not working with builders? Reply "remove"');
    subj := case when sold is not null then 'Your builder on ' || sold else 'Lots for your builder clients' end;
    if step = 0 then
      body := concat_ws(E'\n\n', hi, case when sold is not null then 'I saw you were on the new build at ' || sold || '. ' else '' end
        || 'I specialize in sourcing off-market lots and teardowns for builders. Is the builder you work with looking for more lots right now?',
        'If so, this 2-minute buy box tells me exactly what to look for:', link,
        'If your builder buys a lot I bring them, I pay your brokerage a 2.5% buyer''s agent commission at closing.',
        'If you''re not the one helping them find lots, could you connect me with their acquisitions manager? I''d rather work through you than go around you.');
    elsif step = 1 then
      body := concat_ws(E'\n\n', hi, 'Following up on my note. Is the builder you work with buying lots right now?', 'Here is the 2-minute buy box, mostly checkboxes:', link,
        'Or just reply with the builder''s name and who handles their land buying, and I''ll take it from there.');
    elsif step = 2 then
      body := concat_ws(E'\n\n', hi, 'Quick one: when I tie up an off-market lot, I send it first to the agents and builders whose buy box it fits.',
        'Here is the form so your builder is on that list:', link,
        'Reminder: if your builder buys a lot I bring them, your brokerage gets a 2.5% buyer''s agent commission at closing.',
        'If their acquisitions manager is the better person, a quick intro works too.');
    else
      body := concat_ws(E'\n\n', hi, 'I don''t want to clutter your inbox, so this is my last note on this.',
        'If the builder you work with is buying lots, this form tells me exactly what to send:', link,
        'If they''re not buying right now, or you''d rather I reach their acquisitions manager directly, just reply with a name.');
    end if;
    return json_build_object('subject', case when step = 0 then subj else 'Re: ' || subj end, 'body', body || sig);
  end if;
  subj := case when warm then 'Quick one - what are you buying now?' else 'Builder buy box - 60 seconds' end;
  if step = 0 and warm then
    body := concat_ws(E'\n\n', hi, trim(coalesce('Thanks again for the deal on ' || nullif(b.last_lot,'') || '. ','') || 'I''m tightening up how I send lots so you only see ones that fit what you''re buying today.'),
      'Can you take 60 seconds and fill this out? Cities, zips, price range, lot size.', link, 'You''ll get first look at anything that matches.');
  elsif step = 0 then
    body := concat_ws(E'\n\n', hi, 'I specialize in sourcing off-market lots for builders in NC and SC. So I only send you lots that fit, can you fill out this quick buy box? Cities, zips, price range, lot size.', link,
      'Agents and brokers: fill it out for the builders you represent.');
  elsif step = 1 then
    body := concat_ws(E'\n\n', hi, 'Following up on my note about your buy box. To make it quick, here is a 60-second form, mostly checkboxes:', link,
      'Or just reply with three things: the counties you build in, the lot size you want, and your max price per lot.',
      'If you are an agent or broker who represents builders, the form has a spot for that too, so I can send you lots for your clients.');
  elsif step = 2 then
    body := concat_ws(E'\n\n', hi, 'Quick one: what counties are you buying lots in right now?', 'When I tie up a lot, I send it straight to the builders whose criteria it matches. Here is the form so you are on that list:', link,
      'A one-line reply works too: county + max price per lot.');
  else
    body := concat_ws(E'\n\n', hi, 'I don''t want to clutter your inbox, so this is my last follow-up on this.',
      'If you or the builders you represent are buying lots in NC, SC, GA, TN or FL, this form tells me exactly what to send you:', link,
      'If you are not buying right now, just reply "not now" and I will check back in a few months.');
  end if;
  return json_build_object('subject', case when step = 0 then subj else 'Re: ' || subj end, 'body', body || sig);
end $$;

-- daily run (weekdays): sends from buyers@dominionlandgroup.land with a warm-up ramp (20/day week 1, 40/day week 2, then 75/day, follow-ups included). Agents first.
insert into app_secrets (name, value) values ('buybox_ramp_start', to_char(now() at time zone 'America/New_York','YYYY-MM-DD')) on conflict (name) do update set value = excluded.value;
create or replace function buybox_run() RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
declare acct bigint; b buyers; e json; oid bigint; n_first int := 0; n_fu int := 0; waitd int[] := array[0,3,4,7]; d int; cap int;
begin
  if coalesce((select value from app_secrets where name='buybox_sending'),'off') <> 'on' then return json_build_object('skipped','sending is off'); end if;
  select id into acct from email_accounts where inbox = 'buyer' and lower(email) = 'buyers@dominionlandgroup.land' order by id limit 1;
  if acct is null then return json_build_object('error','buyers@dominionlandgroup.land is not connected'); end if;
  d := (now() at time zone 'America/New_York')::date - coalesce((select value from app_secrets where name='buybox_ramp_start')::date, current_date);
  cap := case when d < 7 then 20 when d < 14 then 40 else 75 end;
  -- replies stop the sequence (out-of-office / auto-replies do not)
  update buyers x set bb_status = case when exists (select 1 from messages m where m.direction='in' and m.channel='email' and lower(m.email_from) like '%' || lower(x.email) || '%' and m.created_at > x.bb_first_sent
                                         and m.body ~* '\m(remove|unsubscribe|stop emailing)\M') then 'removed' else 'replied' end
    where x.bb_status = 'sent' and x.email is not null
      and exists (select 1 from messages m where m.direction='in' and m.channel='email' and lower(m.email_from) like '%' || lower(x.email) || '%' and m.created_at > x.bb_first_sent
                  and coalesce(m.subject,'') !~* '(out of (the )?office|automatic reply|auto.?reply|autoreply|away from|on vacation|delivery status|undeliverable)');
  update buyers set bb_status = 'bounced' where bb_status = 'sent' and bb_last_outbox in (select id from email_outbox where status = 'failed');
  update buyers set bb_status = 'no response' where bb_status = 'sent' and bb_step >= 3 and bb_last_sent < now() - interval '7 days';
  -- follow-ups (count toward the daily cap, at most half of it).
  -- Sent as a fresh email TO THE AGENT. Never as a Gmail reply: replying to our own sent message routes it back to buyers@ (bug fixed Oct 15, returned Oct 24, fixed again Oct 28).
  for b in select * from buyers where bb_status = 'sent' and bb_step < 3 and bb_last_sent < now() - make_interval(days => (waitd)[bb_step + 2]) order by (bb_group = 'Agent') desc, bb_last_sent limit cap / 2 loop
    e := bb_email(b, b.bb_step + 1);
    insert into email_outbox (account_id, to_email, subject, body) values (acct, b.email, e->>'subject', e->>'body') returning id into oid;
    update buyers set bb_step = bb_step + 1, bb_last_sent = now(), bb_last_outbox = oid where id = b.id; n_fu := n_fu + 1;
  end loop;
  -- first emails: high-end agents first, then past buyers, then the rest
  for b in select * from buyers where bb_status = 'not sent' and bb_group is not null and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
           order by (bb_group = 'Agent') desc, (bb_group = 'Past buyer') desc, id limit greatest(cap - n_fu, 0) loop
    e := bb_email(b, 0);
    insert into email_outbox (account_id, to_email, subject, body) values (acct, b.email, e->>'subject', e->>'body') returning id into oid;
    update buyers set bb_status = 'sent', bb_step = 0, bb_first_sent = now(), bb_last_sent = now(), bb_last_outbox = oid where id = b.id; n_first := n_first + 1;
  end loop;
  return json_build_object('first', n_first, 'followups', n_fu, 'cap', cap);
end $function$;
revoke all on function buybox_run() from public, anon, authenticated;
