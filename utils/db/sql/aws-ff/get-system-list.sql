SELECT  
        systems.id,
        systems.manufacturer,
        systems.modality,
        systems.model
FROM    customers 
JOIN    sites       ON  sites.customer_id   = customers.id
JOIN    systems     ON  systems.site_id     = sites.id
WHERE   customers.id = 'C0051'
AND     systems.process_log IS TRUE
AND     systems.id  IN  ('SME14521','SME14522','SME16933','SME16934','SME02524','SME02582','SME00410','SME17372','SME20487','SME16343','SME00444','SME00445')
ORDER BY systems.manufacturer, systems.modality, systems.id

-- SME14521	GE	CT          gesys_ct07.log
-- SME14522	GE	CT          gesys_ct04.log
-- SME16933	GE	CV/IRf      sysError.log
-- SME16934	GE	CV/IR       sysError.log
-- SME02524	GE	MRI         gesys_mr2-ow0.log
-- SME02582	GE	MRI         gesys_lx-mr.log
-- SME00410	Philips	CT      EALInfo.output
-- SME17372	Philips	CT      EALInfo.output
-- SME00444	Philips	CV/IR*  daily_2025_08_19 -> daily_yyyy_mm_dd
-- SME00445	Philips	CV/IR*  daily_2025_08_19 -> daily_yyyy_mm_dd
-- SME20487	Philips	MRI     logcurrent.log
-- SME16343	Siemens	MRI     Application.log