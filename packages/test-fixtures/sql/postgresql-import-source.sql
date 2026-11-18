CREATE SCHEMA import_lab;
COMMENT ON SCHEMA import_lab IS '가져오기 검증 스키마';

CREATE TYPE import_lab.status AS ENUM ('open', 'closed', 'owner''s');
COMMENT ON TYPE import_lab.status IS '처리 상태';

CREATE TABLE import_lab."Dispatch" (
    region integer NOT NULL,
    number bigint GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME import_lab.dispatch_ticket START WITH 7 INCREMENT BY 2),
    status import_lab.status DEFAULT 'open'::import_lab.status,
    tags text[] DEFAULT ARRAY['a;b', '한글']::text[],
    peer_id integer,
    CONSTRAINT dispatch_pk PRIMARY KEY (region, number),
    CONSTRAINT dispatch_region_check CHECK (region > 0)
);
COMMENT ON TABLE import_lab."Dispatch" IS E'출고 ''테이블''\n다음 줄';
COMMENT ON COLUMN import_lab."Dispatch".number IS '식별 번호';

CREATE TABLE import_lab."Peer" (
    id serial PRIMARY KEY,
    dispatch_region integer,
    dispatch_number bigint,
    parent_id integer,
    code text DEFAULT $note$semi;quote's
끝$note$,
    CONSTRAINT peer_dispatch_fk FOREIGN KEY (dispatch_region, dispatch_number) REFERENCES import_lab."Dispatch" (region, number) ON DELETE CASCADE,
    CONSTRAINT peer_parent_fk FOREIGN KEY (parent_id) REFERENCES import_lab."Peer" (id)
);

CREATE UNIQUE INDEX peer_code_uq ON import_lab."Peer" (code);
ALTER TABLE import_lab."Dispatch" ADD CONSTRAINT dispatch_peer_fk FOREIGN KEY (peer_id) REFERENCES import_lab."Peer" (id);
