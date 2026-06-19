-- 初回起動時に自動実行される（docker-entrypoint-initdb.d）
-- database 'handson' は compose の MYSQL_DATABASE で作成済み。ここではテーブルと初期データを用意する。

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users (name) VALUES ('alice'), ('bob'), ('carol');
