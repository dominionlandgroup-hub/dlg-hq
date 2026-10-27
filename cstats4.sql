-- Campaign numbers (v4: deals with no source now count as DLG HQ deals). Pebble's history stays in pebble_* columns; everything done in DLG HQ adds on.
-- DLG HQ writes a transaction (notes 'HQ: ...') when: a purchase agreement is made (offer),
-- a deal moves to Buyer Deals (purchase = under contract), and a buyer deal reaches Closed (sale).
create or replace function campaign_deal_counts() returns table(campaign_id bigint, deals bigint, open bigint, offers bigint, purchases bigint, sales bigint) language sql stable as $$
  select c.id,
    (select count(*) from deals d where d.campaign_id=c.id),
    (select count(*) from deals d where d.campaign_id=c.id and coalesce(d.status,'open')='open'),
    coalesce(c.pebble_offers,0)+(select count(distinct t.deal_id) from transactions t join deals d on d.id=t.deal_id where d.campaign_id=c.id and t.kind='offer' and (coalesce(d.source,'')<>'pebble' or t.notes like 'HQ:%')),
    coalesce(c.pebble_purchases,0)+(select count(*) from deals d where d.campaign_id=c.id and (
        (coalesce(d.source,'')<>'pebble' and (d.board='buyer' or exists(select 1 from transactions t where t.deal_id=d.id and t.kind in ('purchase','sale'))))
        or (d.source='pebble' and exists(select 1 from transactions t where t.deal_id=d.id and t.kind in ('purchase','sale') and t.notes like 'HQ:%')))),
    coalesce(c.pebble_sales,0)+(select count(distinct t.deal_id) from transactions t join deals d on d.id=t.deal_id where d.campaign_id=c.id and t.kind='sale' and (coalesce(d.source,'')<>'pebble' or t.notes like 'HQ:%'))
  from campaigns c $$;
grant execute on function campaign_deal_counts() to authenticated;
