// A curated public-suffix subset. It exists so the pipeline has no network and no
// runtime dependency for eTLD+1 extraction, which only has to be *stable*: the
// bucket key groups rules that concern the same site (PIPELINE 10.3), and a
// suffix we get slightly wrong moves a whole site's rules together, it never
// splits an exception away from the block it must neutralise.
//
// Three sources of truth, checked in this order:
//   EXACT      multi-label suffixes taken from the ICANN section of
//              https://publicsuffix.org/list/ (the frequently-seen ones);
//   WILDCARD   TLDs whose PSL rule is "*.tld", so any single label under them is
//              itself a suffix;
//   SECOND     generic second-level labels that form a suffix under a two-letter
//              ccTLD, which is what most ccTLD rules amount to.
// Changing any of these three re-keys buckets, so it is a reviewed change that
// bumps manifest.layoutVersion, exactly like changing B.

const EXACT_LIST = `
ac.at ac.be ac.cn ac.cr ac.cy ac.id ac.il ac.in ac.ir ac.jp ac.ke ac.kr ac.ma ac.mu
ac.mz ac.nz ac.pa ac.rs ac.rw ac.se ac.th ac.tz ac.ug ac.uk ac.za ac.zm
ad.jp adm.br adv.br
art.br asn.au asso.fr
bel.tr biz.id biz.pl blog.br
co.ae co.am co.ao co.at co.bw co.ci co.ck co.cm co.cr co.cz co.dk co.ee co.gg co.gl
co.gy co.hu co.id co.il co.im co.in co.ir co.je co.jp co.ke co.kr co.ls co.ma co.me
co.mu co.mw co.mz co.na co.nl co.nz co.om co.pn co.rs co.rw co.st co.sz co.th co.tj
co.tt co.tz co.ua co.ug co.uk co.uz co.ve co.vi co.za co.zm co.zw
com.af com.ag com.ai com.al com.am com.ar com.au com.aw com.az com.ba com.bb com.bd
com.bh com.bi com.bm com.bn com.bo com.br com.bs com.bt com.bw com.by com.bz com.cm
com.cn com.co com.cu com.cv com.cw com.cy com.de com.dm com.do com.dz com.ec com.ee
com.eg com.es com.et com.fj com.fr com.ge com.gh com.gi com.gl com.gn com.gp com.gr
com.gt com.gu com.gy com.hk com.hn com.hr com.ht com.iq com.jo com.kg com.kh com.ki
com.km com.kp com.kw com.ky com.kz com.lb com.lc com.lk com.lr com.lv com.ly com.mg
com.mk com.ml com.mo com.mt com.mu com.mv com.mw com.mx com.my com.na com.nf com.ng
com.ni com.np com.nr com.om com.pa com.pe com.pf com.ph com.pk com.pl com.pr com.ps
com.pt com.py com.qa com.ro com.ru com.sa com.sb com.sc com.sd com.sg com.sl com.sn
com.so com.ss com.sv com.sy com.tj com.tm com.tn com.tr com.tt com.tw com.ua com.ug
com.uy com.uz com.vc com.ve com.vi com.vn com.vu com.ws com.ye com.zm
cv.ua
ed.jp edu.ar edu.au edu.bd edu.br edu.cn edu.co edu.cu edu.do edu.ec edu.eg edu.es
edu.gh edu.gr edu.gt edu.hk edu.in edu.it edu.jo edu.kh edu.kw edu.lb edu.lk edu.lv
edu.mk edu.mx edu.my edu.ng edu.ni edu.om edu.pe edu.pk edu.pl edu.pr edu.ps edu.pt
edu.py edu.qa edu.rs edu.ru edu.sa edu.sg edu.sv edu.tr edu.tt edu.tw edu.ua edu.uy
edu.ve edu.vn edu.za
firm.in
gen.in geek.nz
go.id go.jp go.kr go.th go.ug gob.ar gob.bo gob.cl gob.do gob.ec gob.es gob.gt
gob.hn gob.mx gob.ni gob.pa gob.pe gob.sv gob.ve
gov.ae gov.au gov.bd gov.br gov.cn gov.co gov.cy gov.eg gov.gh gov.gr gov.hk gov.il
gov.in gov.iq gov.ir gov.it gov.jo gov.kh gov.kw gov.lb gov.lk gov.ma gov.mo gov.my
gov.ng gov.np gov.om gov.pe gov.ph gov.pk gov.pl gov.pt gov.qa gov.rs gov.ru gov.sa
gov.sg gov.tr gov.tt gov.tw gov.ua gov.uk gov.vn gov.za
gouv.fr govt.nz gr.jp gs.cn gv.at
id.au idv.hk idv.tw in.rs in.th in.ua ind.in info.hu info.pl int.ar
k12.il kiev.ua
lg.jp ltd.uk
maori.nz me.uk mil.co mil.id mil.in mil.pl mil.tr mod.uk msk.ru muni.il my.id
ne.jp ne.kr net.ae net.ar net.au net.bd net.br net.cn net.co net.dz net.ec net.eg
net.gr net.hk net.id net.il net.in net.ir net.jo net.kw net.lb net.lk net.ma net.mx
net.my net.ng net.ni net.nz net.om net.pe net.ph net.pk net.pl net.pt net.py net.qa
net.ru net.sa net.sg net.th net.tr net.tt net.tw net.ua net.uy net.ve net.vn net.za
nhs.uk nom.co nom.es nom.fr nom.ro nom.za
or.at or.id or.jp or.ke or.kr or.th or.ug org.ae org.ar org.au org.bd org.br org.cn
org.co org.cy org.dz org.ec org.eg org.es org.gh org.gr org.hk org.hu org.il org.in
org.ir org.jo org.kw org.lb org.lk org.ma org.mk org.mx org.my org.ng org.ni org.nz
org.om org.pe org.ph org.pk org.pl org.ps org.pt org.py org.qa org.ro org.rs org.ru
org.sa org.sg org.tr org.tt org.tw org.ua org.uk org.uy org.ve org.vn org.za
pe.kr police.uk pp.ru pp.se prd.fr priv.at priv.hu pro.br
re.kr res.in
sch.id sch.uk school.nz spb.ru sport.hu
tm.fr tm.mc tm.ro tm.se
waw.pl web.id web.za
`;

// PSL rules of the form "*.tld".
const WILDCARD_LIST = "bd ck er jm kh mm mz pg ye zw";

// Generic second-level labels under a two-letter ccTLD.
const SECOND_LIST = `
ac ad asn asso biz co com ed edu firm gen go gob gouv gov gr id in ind info int
k12 lg ltd mil name ne net nom or org plc pp prd pro priv re res sch school tm web
`;

// A few private-registry suffixes that carry enough distinct sites to be worth
// grouping properly. Deliberately short: every entry here is one more thing that
// can drift from the real list.
const PRIVATE_LIST = `
github.io gitlab.io pages.dev workers.dev blogspot.com cloudfront.net
s3.amazonaws.com web.app firebaseapp.com netlify.app vercel.app
`;

const split = (text) => text.split(/\s+/).filter((entry) => entry.length > 0);

export const EXACT_SUFFIXES = new Set([...split(EXACT_LIST), ...split(PRIVATE_LIST)]);
export const WILDCARD_TLDS = new Set(split(WILDCARD_LIST));
export const SECOND_LEVEL_LABELS = new Set(split(SECOND_LIST));
