-- 0046 Renaissance Technologies is listed under its chief executive.
--
-- Migration 0004 seeded the fund under Jim Simons, its founder, who died in May 2024. The
-- card and the fund's page show this name beside the fund's, as the person running it.

UPDATE institutions SET manager = 'Peter Brown' WHERE cik = '0001037389' AND manager = 'Jim Simons';
