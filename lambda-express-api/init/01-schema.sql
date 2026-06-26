-- 初回起動時に自動実行される（docker-entrypoint-initdb.d）
-- database 'handson' は compose の MYSQL_DATABASE で作成済み。ここではテーブルと初期データを用意する。

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users (name) VALUES ('alice'), ('bob'), ('carol');

CREATE TABLE IF NOT EXISTS uploads (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT           NOT NULL,
  filename   VARCHAR(255)  NOT NULL,
  s3_key     VARCHAR(512)  NOT NULL,
  file_size  BIGINT        NOT NULL,
  created_at TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
