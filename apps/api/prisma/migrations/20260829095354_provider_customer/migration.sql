-- CreateTable
CREATE TABLE "ProviderCustomer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "AggregatorProvider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCustomer_userId_provider_key" ON "ProviderCustomer"("userId", "provider");

-- AddForeignKey
ALTER TABLE "ProviderCustomer" ADD CONSTRAINT "ProviderCustomer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
