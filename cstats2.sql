-- Campaign numbers: every card on the deal board is a RESPONSE (Pebble made one per responder).
-- Real deals = under contract (purchase recorded or moved to Buyer Deals) and closed (sale recorded).
drop function if exists campaign_deal_counts();
create or replace function campaign_deal_counts() returns table(campaign_id bigint, deals bigint, open bigint, offers bigint, purchases bigint, sales bigint) language sql stable as $$
  select c.id,
    (select count(*) from deals d where d.campaign_id=c.id),
    (select count(*) from deals d where d.campaign_id=c.id and coalesce(d.status,'open')='open'),
    coalesce(c.pebble_offers,0)+(select count(distinct t.deal_id) from transactions t join deals d on d.id=t.deal_id where d.campaign_id=c.id and d.source<>'pebble' and t.kind='offer'),
    coalesce(c.pebble_purchases,0)+(select count(*) from deals d where d.campaign_id=c.id and d.source<>'pebble'
        and (d.board='buyer' or exists(select 1 from transactions t where t.deal_id=d.id and t.kind in ('purchase','sale')))),
    coalesce(c.pebble_sales,0)+(select count(distinct t.deal_id) from transactions t join deals d on d.id=t.deal_id where d.campaign_id=c.id and d.source<>'pebble' and t.kind='sale')
  from campaigns c $$;
grant execute on function campaign_deal_counts() to authenticated;
select sum(deals) responses, sum(open) open, sum(offers) offers, sum(purchases) under_contract, sum(sales) closed from campaign_deal_counts();
