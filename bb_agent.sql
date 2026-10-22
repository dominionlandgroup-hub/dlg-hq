-- Agent version of the buy-box email drip (buyers.bb_group = 'Agent'; last_lot = the new build they sold)
create or replace function bb_email(b buyers, step int) returns json language plpgsql stable security definer set search_path=public as $$
declare hi text := 'Hi ' || coalesce(nullif(b.first_name,''), nullif(split_part(coalesce(b.name,''),' ',1),''), 'there') || ',';
  link text := coalesce((select value from app_secrets where name = 'buybox_link'), 'https://dominionlandgroup-hub.github.io/dlg-hq/buybox.html?t=') || coalesce(b.bb_code, b.bb_token::text);
  sig text := E'\n\nDamien Dupee\nDominion Land Group\n(980) 217-8806\ndominionlandgroup@gmail.com\n\nNot buying lots? Reply "remove" and I will take you off my list.\nDominion Land Group, 1235 East Blvd, Suite C1424, Charlotte, NC 28203';
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
        'If you''re not the one helping them find lots, could you connect me with their acquisitions manager? I''d rather work through you than go around you.');
    elsif step = 1 then
      body := concat_ws(E'\n\n', hi, 'Following up on my note. Is the builder you work with buying lots right now?', 'Here is the 2-minute buy box, mostly checkboxes:', link,
        'Or just reply with the builder''s name and who handles their land buying, and I''ll take it from there.');
    elsif step = 2 then
      body := concat_ws(E'\n\n', hi, 'Quick one: when I tie up an off-market lot, I send it first to the agents and builders whose buy box it fits.',
        'Here is the form so your builder is on that list:', link,
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
