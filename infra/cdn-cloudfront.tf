# Terraform configuration for CloudFront CDN distribution.
# Apply with: terraform apply -var="domain=brandblitz.app" -var="origin_bucket=brand-assets"
# Ensure bucket is configured as an S3 origin or behind a load balancer.

variable "domain" {
  description = "The CDN hostname (e.g. assets.brandblitz.app)"
  type        = string
}

variable "origin_bucket_domain" {
  description = "The S3 bucket website endpoint or Cloudflare R2 public URL"
  type        = string
}

variable "aliases" {
  description = "Additional CNAME aliases"
  type        = list(string)
  default     = []
}

resource "aws_cloudfront_distribution" "cdn" {
  aliases = concat([var.domain], var.aliases)

  origin {
    domain_name = var.origin_bucket_domain
    origin_id   = "storage-origin"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  enabled             = true
  is_ipv6_enabled     = true
  comment             = "BrandBlitz asset CDN — immutable content-hashed URLs"
  default_root_object = ""

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "storage-origin"

    forwarded_values {
      query_string = true
      headers      = ["Accept"]
      cookies {
        forward = "none"
      }
    }

    # Content-hashed URLs are safe to cache for one year
    min_ttl     = 0
    default_ttl = 86400
    max_ttl     = 31536000

    # Compress at edge
    compress = true

    viewer_protocol_policy = "redirect-to-https"
  }

  price_class = "PriceClass_100" # North America + Europe only; switch to PriceClass_All for global

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = "arn:aws:acm:us-east-1:YOUR_ACCOUNT:certificate/YOUR_CERT_ID"
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = {
    Name        = "brandblitz-cdn"
    Environment = "production"
  }
}

output "cloudfront_domain" {
  value = aws_cloudfront_distribution.cdn.domain_name
}

output "cloudfront_hosted_zone_id" {
  value = aws_cloudfront_distribution.cdn.hosted_zone_id
}
