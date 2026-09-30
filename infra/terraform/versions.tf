terraform {
  required_version = ">= 1.6"
  required_providers {
    yandex = {
      source  = "yandex-cloud/yandex"
      version = "~> 0.130"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
  # Состояние хранится в закрытом бакете в Яндекс Облаке (РФ).
  # Адрес бакета и ключи передаются при `terraform init -backend-config=...` из секретов выкладки.
  backend "s3" {
    endpoints                   = { s3 = "https://storage.yandexcloud.net" }
    region                      = "ru-central1"
    skip_region_validation      = true
    skip_credentials_validation = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }
}

provider "yandex" {
  # Ключ сервисного аккаунта — из переменной окружения YC_SERVICE_ACCOUNT_KEY_FILE (задаёт workflow).
  cloud_id  = var.cloud_id
  folder_id = var.folder_id
  zone      = var.zone
}
