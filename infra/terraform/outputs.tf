# Только идентификаторы — без паролей и ключей.
output "network_id" { value = yandex_vpc_network.main.id }
output "pg_cluster_id" { value = yandex_mdb_postgresql_cluster.main.id }
output "pg_host_rw" { value = "c-${yandex_mdb_postgresql_cluster.main.id}.rw.mdb.yandexcloud.net" }
output "files_bucket" { value = yandex_storage_bucket.files.bucket }
output "backups_bucket" { value = yandex_storage_bucket.backups.bucket }
output "lockbox_secret_id" { value = yandex_lockbox_secret.app.id }
output "app_service_account_id" { value = yandex_iam_service_account.app.id }
output "registry_id" { value = yandex_container_registry.main.id }
