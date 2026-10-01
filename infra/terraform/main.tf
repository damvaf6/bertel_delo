locals {
  name = "delo-${var.env}"
}

# ---------------------------------------------------------------- сеть (только внутренняя)
# Лимит облака на число сетей мал (их занимают остатки bertel.online в каталоге default), поэтому, если в каталоге
# контура сеть уже есть, берём её (existing_network_id) и добавляем в неё свою подсеть; иначе создаём свою.
resource "yandex_vpc_network" "main" {
  count = var.existing_network_id == "" ? 1 : 0
  name  = local.name
}

locals {
  network_id = var.existing_network_id != "" ? var.existing_network_id : yandex_vpc_network.main[0].id
}

resource "yandex_vpc_subnet" "main" {
  name           = "${local.name}-a"
  zone           = var.zone
  network_id     = local.network_id
  v4_cidr_blocks = ["10.10.0.0/24"]
}

# ---------------------------------------------------------------- ключ шифрования
resource "yandex_kms_symmetric_key" "main" {
  name                = local.name
  description         = "Шифрование файлов и секретов БЕРТЕЛ Дело (${var.env})"
  default_algorithm   = "AES_256"
  rotation_period     = "8760h" # раз в год
  deletion_protection = true
}

# ---------------------------------------------------------------- сервисные аккаунты
# app — от его имени работает контейнер ядра: файлы, секреты, шифрование.
resource "yandex_iam_service_account" "app" {
  name = "${local.name}-app"
}

# storage-admin — только для создания/настройки бакетов из Terraform.
resource "yandex_iam_service_account" "storage_admin" {
  name = "${local.name}-storage-admin"
}

resource "yandex_resourcemanager_folder_iam_member" "storage_admin" {
  folder_id = var.folder_id
  role      = "storage.admin"
  member    = "serviceAccount:${yandex_iam_service_account.storage_admin.id}"
}

resource "yandex_iam_service_account_static_access_key" "storage_admin" {
  service_account_id = yandex_iam_service_account.storage_admin.id
  description        = "Terraform: управление бакетами"
}

resource "yandex_iam_service_account_static_access_key" "app" {
  service_account_id = yandex_iam_service_account.app.id
  description        = "Контейнер ядра: доступ к бакету файлов"
}

resource "yandex_kms_symmetric_key_iam_binding" "use" {
  symmetric_key_id = yandex_kms_symmetric_key.main.id
  role             = "kms.keys.encrypterDecrypter"
  members = [
    "serviceAccount:${yandex_iam_service_account.app.id}",
    "serviceAccount:${yandex_iam_service_account.storage_admin.id}",
  ]
}

# ---------------------------------------------------------------- PostgreSQL
resource "random_password" "pg_app" {
  length  = 32
  special = false
}

# Ключ подписи сессий и ссылок ядра (APP_SECRET) — генерируется здесь и сразу уходит в Lockbox.
resource "random_password" "app_secret" {
  length  = 48
  special = false
}

resource "yandex_mdb_postgresql_cluster" "main" {
  name                = local.name
  environment         = "PRODUCTION"
  network_id          = local.network_id
  deletion_protection = true

  config {
    version = "16"
    resources {
      resource_preset_id = var.pg_preset
      disk_type_id       = "network-ssd"
      disk_size          = var.pg_disk_gb
    }
    # Автоматическая копия каждую ночь (01:00 UTC = 04:00 МСК) + журнал изменений для восстановления на любой момент
    backup_window_start {
      hours   = 1
      minutes = 0
    }
    backup_retain_period_days = var.pg_backup_days
    access {
      web_sql   = false
      data_lens = false
    }
  }

  host {
    zone             = var.zone
    subnet_id        = yandex_vpc_subnet.main.id
    assign_public_ip = false
  }

  maintenance_window {
    type = "WEEKLY"
    day  = "SUN"
    hour = 3
  }
}

resource "yandex_mdb_postgresql_user" "app" {
  cluster_id = yandex_mdb_postgresql_cluster.main.id
  name       = "delo_app"
  password   = random_password.pg_app.result
  conn_limit = 50
}

resource "yandex_mdb_postgresql_database" "app" {
  cluster_id = yandex_mdb_postgresql_cluster.main.id
  name       = "delo"
  owner      = yandex_mdb_postgresql_user.app.name
  lc_collate = "C" # Yandex MDB принимает "C", "en_US.UTF-8", "ru_RU.UTF-8"
  lc_type    = "C"

  extension { name = "pgcrypto" }
  extension { name = "citext" }
}

# ---------------------------------------------------------------- Object Storage
# Файлы заявок: закрыто, шифрование KMS, версии (удалённое можно вернуть), выдача только временными ссылками.
resource "yandex_storage_bucket" "files" {
  bucket     = "${local.name}-files-${var.name_suffix}"
  access_key = yandex_iam_service_account_static_access_key.storage_admin.access_key
  secret_key = yandex_iam_service_account_static_access_key.storage_admin.secret_key

  anonymous_access_flags {
    read        = false
    list        = false
    config_read = false
  }

  versioning {
    enabled = true
  }

  server_side_encryption_configuration {
    rule {
      apply_server_side_encryption_by_default {
        kms_master_key_id = yandex_kms_symmetric_key.main.id
        sse_algorithm     = "aws:kms"
      }
    }
  }

  lifecycle_rule {
    id      = "restore-window"
    enabled = true
    noncurrent_version_expiration {
      days = var.files_noncurrent_days
    }
  }

  grant {
    id          = yandex_iam_service_account.app.id
    type        = "CanonicalUser"
    permissions = ["READ", "WRITE"]
  }

  depends_on = [yandex_resourcemanager_folder_iam_member.storage_admin, yandex_kms_symmetric_key_iam_binding.use]
}

# Дополнительные копии базы (выгрузки): блокировка от удаления на 30 дней, хранение 90 дней.
resource "yandex_storage_bucket" "backups" {
  bucket     = "${local.name}-backups-${var.name_suffix}"
  access_key = yandex_iam_service_account_static_access_key.storage_admin.access_key
  secret_key = yandex_iam_service_account_static_access_key.storage_admin.secret_key

  anonymous_access_flags {
    read        = false
    list        = false
    config_read = false
  }

  versioning {
    enabled = true
  }

  object_lock_configuration {
    object_lock_enabled = "Enabled"
    rule {
      default_retention {
        mode = "GOVERNANCE"
        days = 30
      }
    }
  }

  server_side_encryption_configuration {
    rule {
      apply_server_side_encryption_by_default {
        kms_master_key_id = yandex_kms_symmetric_key.main.id
        sse_algorithm     = "aws:kms"
      }
    }
  }

  lifecycle_rule {
    id      = "keep-90-days"
    enabled = true
    expiration {
      days = 90
    }
    noncurrent_version_expiration {
      days = 1
    }
  }

  grant {
    id          = yandex_iam_service_account.app.id
    type        = "CanonicalUser"
    permissions = ["READ", "WRITE"] # хранилище не даёт WRITE без READ; удаление копий запрещает блокировка
  }

  depends_on = [yandex_resourcemanager_folder_iam_member.storage_admin, yandex_kms_symmetric_key_iam_binding.use]
}

# ---------------------------------------------------------------- секреты (Lockbox)
resource "yandex_lockbox_secret" "app" {
  name                = "${local.name}-app"
  description         = "Секреты контейнера ядра (${var.env}). Меняются только здесь."
  kms_key_id          = yandex_kms_symmetric_key.main.id
  deletion_protection = true
}

resource "yandex_lockbox_secret_version" "app" {
  secret_id = yandex_lockbox_secret.app.id
  entries {
    key        = "DATABASE_URL"
    text_value = "postgres://${yandex_mdb_postgresql_user.app.name}:${random_password.pg_app.result}@c-${yandex_mdb_postgresql_cluster.main.id}.rw.mdb.yandexcloud.net:6432/${yandex_mdb_postgresql_database.app.name}?sslmode=verify-full"
  }
  entries {
    key        = "APP_SECRET"
    text_value = random_password.app_secret.result
  }
  entries {
    key        = "S3_ACCESS_KEY"
    text_value = yandex_iam_service_account_static_access_key.app.access_key
  }
  entries {
    key        = "S3_SECRET_KEY"
    text_value = yandex_iam_service_account_static_access_key.app.secret_key
  }
}

resource "yandex_lockbox_secret_iam_binding" "app_read" {
  secret_id = yandex_lockbox_secret.app.id
  role      = "lockbox.payloadViewer"
  members   = ["serviceAccount:${yandex_iam_service_account.app.id}"]
}

# ---------------------------------------------------------------- реестр образов
resource "yandex_container_registry" "main" {
  name = local.name
}

# Контейнер ядра забирает образы из реестра от имени app.
resource "yandex_container_registry_iam_binding" "puller" {
  registry_id = yandex_container_registry.main.id
  role        = "container-registry.images.puller"
  members     = ["serviceAccount:${yandex_iam_service_account.app.id}"]
}
